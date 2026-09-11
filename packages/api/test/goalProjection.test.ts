import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import type { RedisClientType } from 'redis';
import { serializeGoal, type GoalProjectionRow } from '../services/goalProjection.js';

after(async () => {
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

test('goal projection redacts nested failure, checkpoint, and provider live-summary preview paths', async () => {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const previewPath = '/tmp/goals/goal-2283/.propr/previews/dashboard.png';
  const sourcePath = '/tmp/goals/goal-2283/.propr/preview-src/capture.ts';
  try {
    await database.schema.createTable('task_history', table => {
      table.increments('history_id');
      table.text('task_id');
      table.text('state');
      table.text('timestamp');
    });
    await database.schema.createTable('goal_checkpoints', table => {
      table.text('checkpoint_id');
      table.text('goal_id');
      table.text('owner_id');
      table.text('kind');
      table.text('state');
      table.text('commit_sha');
      table.text('commit_message');
      table.text('include_paths');
      table.text('exclude_paths');
      table.text('summary');
      table.text('error');
      table.text('created_at');
      table.text('completed_at');
    });
    await database('task_history').insert({
      task_id: 'goal-task-2283', state: 'processing', timestamp: '2026-09-11T00:00:00.000Z',
    });
    await database('goal_checkpoints').insert({
      checkpoint_id: 'checkpoint-1', goal_id: 'goal-2283', owner_id: 'owner-1', kind: 'agent', state: 'failed',
      commit_message: `Capture ${previewPath}`, include_paths: JSON.stringify([sourcePath, 'src/safe.ts']),
      exclude_paths: JSON.stringify([previewPath]), summary: `Rendered from ${sourcePath}`,
      error: `Could not publish ${previewPath}`, created_at: '2026-09-11T00:00:01.000Z', completed_at: null,
    });
    const liveOutput = [
      { method: 'turn/plan/updated', params: { plan: [
        { step: `Inspect ${sourcePath}`, status: 'completed' },
        { step: `Publish ${previewPath}`, status: 'inProgress' },
      ] } },
      { method: 'thread/goal/updated', params: { goal: {
        objective: `Verify ${sourcePath}`, status: 'active', tokenBudget: 1000, tokensUsed: 250, timeUsedSeconds: 30,
      } } },
    ].map(record => JSON.stringify(record)).join('\n');
    const redisClient = {
      get: async (key: string) => {
        if (key === 'agent:output:goal-task-2283') return liveOutput;
        if (key === 'worker:state:goal-task-2283') return JSON.stringify({ history: [{
          state: 'codex_execution', timestamp: '2026-09-11T00:00:00.000Z',
        }] });
        return null;
      },
    } as unknown as RedisClientType;
    const row = {
      goal_id: 'goal-2283', owner_id: 'owner-1', owner_login: 'alice', repository: 'acme/repo',
      title: 'Preview goal', objective: `Ship ${previewPath}`, launch_strategy: 'direct',
      initial_prompt: `Use ${sourcePath}`, attachments: null, base_branch: 'main', branch_name: 'goal/preview',
      worktree_path: '/tmp/goals/goal-2283', agent_id: 'codex', agent_alias: 'codex', agent_type: 'codex',
      requested_model: 'gpt-5.6', effective_model: 'gpt-5.6', max_parallel_tasks: 2, ultrafix: 0,
      desired_state: 'running', result_state: 'failed', current_task_id: 'goal-task-2283', session_id: null,
      conversation_id: null, run_generation: 1, run_claim: null, claimed_at: null, active_turn_id: null,
      pause_confirmed_at: null, resume_requested: 0, final_pr_number: null, final_pr_url: null,
      artifact_refs: null, artifact_stats: null, artifacts_checked_at: null,
      failure_reason: `Provider failed at ${previewPath}`, create_idempotency_key: null,
      create_idempotency_operation: null, create_payload_hash: null, control_generation: 2,
      control_ack_generation: 1, task_reconciled_at: null, created_at: '2026-09-11T00:00:00.000Z',
      updated_at: '2026-09-11T00:00:02.000Z', started_at: '2026-09-11T00:00:00.000Z', paused_at: null,
      paused_ms: 0, completed_at: '2026-09-11T00:00:03.000Z', checkpoint_interval_minutes: 15,
      last_checkpoint_at: '2026-09-11T00:00:01.000Z', last_checkpoint_commit_sha: null,
      checkpoint_count: 1, checkpoint_error: `Checkpoint source ${sourcePath}`,
    } satisfies GoalProjectionRow;

    const projected = await serializeGoal(database, redisClient, row);
    const serialized = JSON.stringify(projected);

    assert.equal(serialized.includes(previewPath), false, serialized);
    assert.equal(serialized.includes(sourcePath), false, serialized);
    assert.match(serialized, /local preview omitted/);
    assert.equal(projected.maxParallelTasks, 2);
    assert.equal(projected.ultrafix, false);
    assert.deepEqual(projected.control, { requestGeneration: 2, acknowledgedGeneration: 1, pending: true });
    assert.equal(projected.checkpoint?.count, 1);
    assert.equal(projected.checkpoint?.latest?.include.length, 2);
    assert.equal(projected.liveSummary.todos.length, 2);
    assert.equal(projected.liveSummary.nativeGoal?.tokensUsed, 250);
  } finally {
    await database.destroy();
  }
});
