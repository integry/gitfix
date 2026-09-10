import { getIssueQueue, getIndexingQueue } from '@propr/core';
import type { ToolDeps } from './tools.js';
import type { Operation } from './operations.js';
import type { McpPrincipal } from './policy.js';

const commentTools = ['review_pull_request', 'fix_review_findings', 'run_ultrafix'];
const trackedTools = [...commentTools, 'send_task_followup', 'revert_pull_request_commit', 'index_repository'];
const terminalStates = ['completed', 'failed', 'cancelled'];

/** Resolve the execution from the actual job or the exact triggering comment. */
export async function trackExecution(deps: ToolDeps, row: Operation, principal: McpPrincipal, receipt: Record<string, unknown>): Promise<void> {
  if (!trackedTools.includes(row.tool) || !row.result) return;
  const { db } = deps;
  const result = JSON.parse(row.result);
  if (result.error || (result.executionResolved && terminalStates.includes(row.state))) return;
  const task = row.tool === 'index_repository' ? undefined : await findExecutionTask(deps, row, result);
  if (task) await trackTask(deps, row, { task, result, receipt });
  else if (result.jobId) await trackQueuedJob(row, result.jobId, receipt);
  else if (Date.now() - Number(row.created_at) > 120000) receipt.state = 'unknown';
  if (result.pullRequest) {
    const [owner, repo] = String(row.repository).split('/');
    const { data: pr } = await principal.github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: result.pullRequest });
    result.currentHead = pr.head.sha;
    result.results = { tool: 'get_pull_request_discussion', repository: row.repository, pullRequest: result.pullRequest, taskId: result.continuation?.taskId };
  }
  if (terminalStates.includes(String(receipt.state))) result.executionResolved = true;
  receipt.result = result;
  if (receipt.state === 'unknown') receipt.message = 'Execution cannot yet be confirmed. Inspect the linked comment/job; polling can still resolve it. Do not blindly resubmit.';
  await db('mcp_operations').where({ id: row.id }).update({ state: receipt.state, result: JSON.stringify(result), updated_at: Date.now() });
}

interface ExecutionResult {
  jobId?: string; commentId?: number; pullRequest?: number;
  continuation?: { taskId?: string; jobId?: string; sourceTaskId?: string };
  reviewResults?: Array<{ success: boolean; commentId?: number; commentUrl?: string }>;
  loop?: { completionStatus?: string | null } & Record<string, unknown>;
}
interface TrackingContext {
  task: { task_id: string; initial_job_data: unknown };
  result: ExecutionResult; receipt: Record<string, unknown>;
}

async function findExecutionTask(deps: ToolDeps, row: Operation, result: ExecutionResult) {
  const { db } = deps;
  const continuation = result.continuation || {};
  const query = db('tasks').where({ repository: row.repository }).whereNot('task_type', 'goal');
  if (commentTools.includes(row.tool)) {
    if (!result.commentId || !result.pullRequest) return undefined;
    const data = `CASE WHEN json_valid(initial_job_data) THEN initial_job_data ELSE '{}' END`;
    // The selected command owns the execution. Batch membership alone must not
    // attach an older, superseded command to the new command's outcome.
    query.where({ issue_number: result.pullRequest }).whereRaw(`CASE
      WHEN json_extract(${data}, '$.commandCommentId') IS NOT NULL THEN
        json_extract(${data}, '$.commandCommentId') = ?
        AND COALESCE(json_extract(${data}, '$.commandCommentType'), 'issue') = 'issue'
      WHEN json_type(${data}, '$.comments') = 'array' THEN EXISTS (
        SELECT 1 FROM json_each(${data}, '$.comments')
        WHERE json_extract(json_each.value, '$.id') = ?
          AND COALESCE(json_extract(json_each.value, '$.type'), 'issue') = 'issue'
      )
      ELSE json_extract(${data}, '$.commentId') = ?
    END`, [result.commentId, result.commentId, result.commentId]);
    if (row.tool === 'run_ultrafix') {
      // Ultrafix starts as either a review or fix and is bound to its work epoch.
      query.whereRaw(`json_extract(${data}, '$.ultrafixMeta.workEpoch') IS NOT NULL`);
    } else {
      query.whereRaw(`json_extract(${data}, '$.commandMode') = ?`, [row.tool === 'review_pull_request' ? 'review' : 'fix']);
    }
  } else {
    query.andWhere(builder => builder.where('task_id', result.jobId || continuation.taskId).orWhere('job_id', result.jobId || continuation.jobId));
  }
  return query.orderBy('created_at', 'desc').first('task_id', 'initial_job_data');
}

async function trackTask(deps: ToolDeps, row: Operation, { task, result, receipt }: TrackingContext): Promise<void> {
  result.continuation = { ...result.continuation, taskId: task.task_id };
  const event = await deps.db('task_history').where({ task_id: task.task_id }).orderBy('history_id', 'desc').first('state', 'timestamp', 'reason', 'metadata');
  const metadata = typeof event?.metadata === 'string' ? JSON.parse(event.metadata) : event?.metadata;
  receipt.targetState = { taskId: task.task_id, state: event?.state, timestamp: event?.timestamp, reason: event?.reason, reviewResults: metadata?.reviewResults };
  if (metadata?.reviewResults) result.reviewResults = metadata.reviewResults;
  receipt.state = terminalStates.includes(event?.state) ? event.state : !event || event.state === 'pending' ? 'queued' : 'running';
  if (event?.state === 'completed' && result.reviewResults?.length && result.reviewResults.every(review => !review.success)) receipt.state = 'failed';
  if (row.tool === 'run_ultrafix') await trackUltrafix(deps, row, { task, result, receipt });
}

async function trackQueuedJob(row: Operation, jobId: string, receipt: Record<string, unknown>): Promise<void> {
  try {
    const queue = row.tool === 'index_repository' ? await getIndexingQueue() : await getIssueQueue();
    const job = await queue.getJob(jobId);
    const state = await job?.getState();
    // Queue completion without task persistence is not proof that work ran.
    receipt.state = queueReceiptState(state, row.tool === 'index_repository');
    receipt.targetState = { jobId, queueState: state };
  } catch { receipt.state = row.state === 'failed' ? 'failed' : 'unknown'; }
}

function queueReceiptState(state: string | undefined, indexing: boolean): string {
  if (state === 'active') return 'running';
  if (state === 'failed') return 'failed';
  if (state === 'completed' && indexing) return 'completed';
  return ['waiting', 'delayed', 'prioritized', 'waiting-children', 'paused'].includes(state || '') ? 'queued' : 'unknown';
}

async function trackUltrafix(deps: ToolDeps, row: Operation, context: TrackingContext): Promise<void> {
  const { task, result, receipt } = context;
  if (result.loop?.completionStatus) { receipt.state = result.loop.completionStatus === 'succeeded' ? 'completed' : 'failed'; return; }
  if (!result.pullRequest) { receipt.state = 'unknown'; return; }
  const jobData = typeof task.initial_job_data === 'string' ? JSON.parse(task.initial_job_data) : task.initial_job_data as { ultrafixMeta?: { workEpoch?: number } } | null;
  const epoch = jobData?.ultrafixMeta?.workEpoch;
  const [owner, repo] = String(row.repository).split('/');
  const stored = await deps.redisClient.get(`ultrafix:state:${owner}:${repo}:${result.pullRequest}`);
  const loop = stored ? JSON.parse(stored) : null;
  if (epoch === undefined || !loop || loop.workEpoch !== epoch) {
    receipt.state = 'unknown';
    return;
  }
  const tasks = await deps.db('tasks').where({ repository: row.repository, issue_number: result.pullRequest }).whereNot('task_type', 'goal')
    .whereRaw(`json_extract(CASE WHEN json_valid(initial_job_data) THEN initial_job_data ELSE '{}' END, '$.ultrafixMeta.workEpoch') = ?`, [epoch])
    .orderBy('created_at', 'desc').limit(50).select('task_id');
  result.loop = { workEpoch: epoch, active: loop.active, cycleCount: loop.cycleCount, reviewCount: loop.reviewCount, fixCount: loop.fixCount,
    completionStatus: loop.completionStatus, completionReason: loop.completionReason, finalScore: loop.finalScore, tasks: tasks.map(task => task.task_id) };
  result.continuation = { ...result.continuation, sourceTaskId: task.task_id, taskId: tasks[0]?.task_id || task.task_id };
  receipt.state = loop.active ? 'running' : loop.completionStatus === 'succeeded' ? 'completed' : loop.completionStatus === 'failed' ? 'failed' : 'unknown';
}
