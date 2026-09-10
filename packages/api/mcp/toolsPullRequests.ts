import { z } from 'zod';
import { McpError } from './config.js';
import { createTaskRoutes } from '../routes/taskRoutes.js';
import { callWorkflow } from './adapter.js';
import { type McpTool, type ToolDeps, repositorySchema, mutationShape, ok, textSchema } from './tools.js';

export function addPullRequestTools(tools: McpTool[], deps: ToolDeps): void {
  const tasks = createTaskRoutes({ db: deps.db, taskQueue: deps.taskQueue });
  const shape = { repository: repositorySchema, pullRequest: z.number().int().positive() };
  const mutation = { ...shape, ...mutationShape, expectedHead: z.string().regex(/^[0-9a-f]{40}$/) };
  const pull = async (principal: Parameters<McpTool['run']>[0]['principal'], args: Record<string, any>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const [owner, repo] = args.repository.split('/');
    const response = await principal.github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: args.pullRequest });
    if (args.expectedHead && response.data.head.sha !== args.expectedHead) throw new McpError('STALE_HEAD', 'Pull request head changed. Read it again.', 409);
    return { owner, repo, pr: response.data };
  };
  tools.push({ name: 'get_pull_request', description: 'Read a pull request, exact head revision, review/check state and canonical GitHub link.', scope: 'read', readOnly: true, schema: z.object(shape).strict(), run: async ({ principal, args }) => {
    const { owner, repo, pr } = await pull(principal, args);
    const [reviews, checks] = await Promise.all([
      principal.github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { owner, repo, pull_number: args.pullRequest, per_page: 100 }),
      principal.github.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { owner, repo, ref: pr.head.sha, per_page: 100 }),
    ]);
    return ok({ number: pr.number, title: pr.title, body: pr.body, state: pr.state, draft: pr.draft, merged: pr.merged, head: pr.head.sha, base: pr.base.ref, url: pr.html_url,
      reviews: reviews.data.map(review => ({ id: review.id, state: review.state, body: review.body, commitId: review.commit_id })),
      checks: checks.data.check_runs.map(check => ({ name: check.name, status: check.status, conclusion: check.conclusion, url: check.html_url })) });
  } });
  for (const [name, command, scope] of [['review_pull_request', 'review', 'review'], ['fix_review_findings', 'fix', 'execute'], ['run_ultrafix', 'ultrafix', 'execute']] as const) {
    tools.push({ name, description: `Request the existing /${command} command at an exact PR head. Returns a durable receipt; normal instance event intake starts work.`, scope,
      schema: z.object({ ...mutation, instructions: textSchema.optional(), ...(command === 'ultrafix' ? { goal: z.number().int().min(1).max(10).default(9), maxCycles: z.number().int().min(1).max(10).default(3) } : {}) }).strict(),
      run: async ({ principal, args, operationId }) => {
        if (command === 'ultrafix') deps.policy.requireScope(principal, 'review');
        const { owner, repo, pr } = await pull(principal, args);
        if (pr.state !== 'open' || pr.merged) throw new McpError('PRECONDITION_FAILED', 'Pull request is not open.', 409);
        if (args.instructions && /^\s*\//m.test(args.instructions)) throw new McpError('INVALID_INPUT', 'Instructions cannot introduce additional slash commands.');
        const body = `/${command}${command === 'ultrafix' ? ` goal=${args.goal} max=${args.maxCycles}` : ''}${args.instructions ? `\n\n${args.instructions}` : ''}\n\n<!-- propr-mcp:${operationId}; head:${args.expectedHead} -->`;
        const { data } = await principal.github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: args.pullRequest, body });
        return { status: 202, data: { repository: args.repository, pullRequest: args.pullRequest, commentId: data.id, url: data.html_url, expectedHead: args.expectedHead, state: 'awaiting_event_intake' } };
      } });
  }
  tools.push({ name: 'update_pull_request_branch', description: 'Update the PR branch from its base, matching /merge semantics. Does not merge the pull request.', scope: 'execute', schema: z.object(mutation).strict(), run: async ({ principal, args }) => {
    const { owner, repo, pr } = await pull(principal, args);
    if (pr.state !== 'open' || pr.merged) throw new McpError('PRECONDITION_FAILED', 'Pull request is not open.', 409);
    const response = await principal.github.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch', { owner, repo, pull_number: args.pullRequest, expected_head_sha: args.expectedHead });
    return { status: 202, data: { repository: args.repository, pullRequest: args.pullRequest, expectedHead: args.expectedHead, url: response.data.url, message: response.data.message } };
  } });
  tools.push({ name: 'get_pull_request_revert_preview', description: 'Preview reverting an exact commit belonging to a pull request using the existing backend.', scope: 'read', readOnly: true,
    schema: z.object({ ...shape, commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict(), run: async ({ principal, args }) => {
      const { owner, repo } = await pull(principal, args);
      return callWorkflow(tasks.getRevertPreview, principal, { query: { owner, repo, pr: String(args.pullRequest), commit: args.commit } });
    } });
  tools.push({ name: 'revert_pull_request_commit', description: 'Queue the supported revert workflow for an exact PR commit/comment at its expected head. Does not execute arbitrary shell input.', scope: 'execute',
    schema: z.object({ ...mutation, commit: z.string().regex(/^[0-9a-f]{40}$/), commentId: z.number().int().positive().max(10000000000) }).strict(), run: async ({ principal, args }) => {
      const { owner, repo, pr } = await pull(principal, args);
      if (pr.state !== 'open' || pr.merged) throw new McpError('PRECONDITION_FAILED', 'Pull request must be open.', 409);
      const response = await callWorkflow(tasks.revertChanges, principal, { body: { owner, repo, pr: String(args.pullRequest), commit: args.commit, commentId: String(args.commentId), expectedHead: args.expectedHead } });
      return { status: 202, data: response.data };
    } });
  tools.push({ name: 'merge_pull_request', description: 'Merge an open PR only at its exact expected head with passing checks and satisfied review/protection rules. Requires merge scope and current write permission.', scope: 'merge',
    schema: z.object({ ...mutation, method: z.enum(['merge', 'squash', 'rebase']).default('squash') }).strict(), run: async ({ principal, args }) => {
      const { owner, repo, pr } = await pull(principal, args);
      if (pr.state !== 'open' || pr.draft || pr.merged) throw new McpError('PRECONDITION_FAILED', 'PR must be open and ready for review.', 409);
      const result = await principal.github.graphql<{ repository: { pullRequest: { headRefOid: string; mergeStateStatus: string; reviewDecision: string | null; commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> } } } }>(
        `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid mergeStateStatus reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}`, { owner, repo, number: args.pullRequest });
      const state = result.repository.pullRequest;
      if (state.headRefOid !== args.expectedHead || state.mergeStateStatus !== 'CLEAN' || ['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(state.reviewDecision || '')) throw new McpError('CHECKS_NOT_PASSED', 'PR head, required reviews or branch protection requirements are not satisfied.', 409);
      const rollup = state.commits.nodes[0]?.commit.statusCheckRollup;
      if (rollup && rollup.state !== 'SUCCESS') throw new McpError('CHECKS_NOT_PASSED', 'Head checks are not all passing.', 409);
      // GitHub atomically checks expected head and repository rules at merge.
      // No admin bypass or auto-merge mutation is requested.
      const response = await principal.github.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', { owner, repo, pull_number: args.pullRequest, sha: args.expectedHead, merge_method: args.method });
      if (!response.data.merged) throw new McpError('MERGE_REJECTED', response.data.message, 409);
      return ok({ merged: true, sha: response.data.sha, url: pr.html_url });
    } });
}
