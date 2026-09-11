import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Response } from 'express';
import knex, { type Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { FlatRequest } from '../requestTypes.js';
import { createTaskHistoryRoutes } from '../routes/taskHistoryRoutes.js';

after(async () => {
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

async function createHistoryDatabase(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('tasks', table => {
    table.text('task_id').primary();
    table.text('repository');
    table.text('task_type');
    table.integer('issue_number');
    table.text('correlation_id');
    table.text('initial_job_data');
    table.text('model_name');
  });
  await database.schema.createTable('task_history', table => {
    table.increments('history_id');
    table.text('task_id');
    table.text('state');
    table.text('timestamp');
    table.text('reason');
    table.text('metadata');
  });
  await database.schema.createTable('llm_executions', table => {
    table.increments('execution_id');
    table.text('task_id');
    table.text('start_time');
    table.text('session_id');
  });
  await database.schema.createTable('llm_logs', table => {
    table.increments('log_id');
    table.text('draft_id');
    table.text('execution_type');
    table.text('start_time');
    table.text('usage_metrics');
  });
  return database;
}

function responseRecorder(): { response: Response; body: () => unknown } {
  let payload: unknown;
  const response = {
    status() { return response; },
    json(value: unknown) { payload = value; return response; },
  } as unknown as Response;
  return { response, body: () => payload };
}

function assertRedacted(payload: unknown, localPaths: readonly string[]): void {
  const serialized = JSON.stringify(payload);
  for (const localPath of localPaths) assert.equal(serialized.includes(localPath), false, localPath);
  assert.match(serialized, /local preview omitted/);
}

test('task history redacts nested database history and task info without changing non-string fields', async () => {
  const database = await createHistoryDatabase();
  const previewPath = '/tmp/jobs/task-db/.propr/previews/private.png';
  const sourcePath = '/tmp/jobs/task-db/.propr/preview-src/capture.ts';
  try {
    await database('tasks').insert({
      task_id: 'task-db', repository: 'acme/repo', task_type: 'issue', issue_number: 2283,
      correlation_id: 'correlation-1', model_name: 'codex',
      initial_job_data: JSON.stringify({
        title: `Captured ${sourcePath}`,
        subtitle: 'Nested task info',
        agentAlias: 'codex',
      }),
    });
    await database('task_history').insert({
      task_id: 'task-db', state: 'failed', timestamp: '2026-09-11T00:00:00.000Z',
      reason: `Could not read ${previewPath}`,
      metadata: JSON.stringify({
        diagnostic: { source: sourcePath, retryable: false, attempts: 2 },
        files: [previewPath, { staged: sourcePath, exists: true }],
        nestedMetadata: { [previewPath]: { source: sourcePath } },
      }),
    });
    const routes = createTaskHistoryRoutes({
      db: database,
      redisClient: { get: async () => null } as unknown as RedisClientType,
      taskQueue: {} as never,
    });
    const recorder = responseRecorder();

    await routes.getTaskHistory({ params: { taskId: 'task-db' } } as unknown as FlatRequest, recorder.response);

    const body = recorder.body() as {
      history: Array<{ metadata: {
        diagnostic: { retryable: boolean; attempts: number };
        files: unknown[];
        nestedMetadata: Record<string, { source: string }>;
      } }>;
      taskInfo: { number: number; title: string };
      usageMetrics: null;
      usageMetricRecords: unknown[];
    };
    assertRedacted(body, [previewPath, sourcePath]);
    assert.equal(body.taskInfo.number, 2283);
    assert.equal(body.history[0].metadata.diagnostic.retryable, false);
    assert.equal(body.history[0].metadata.diagnostic.attempts, 2);
    assert.equal(body.history[0].metadata.files.length, 2);
    assert.deepEqual(Object.keys(body.history[0].metadata.nestedMetadata), ['[local preview omitted]']);
    assert.equal(body.usageMetrics, null);
    assert.deepEqual(body.usageMetricRecords, []);
  } finally {
    await database.destroy();
  }
});

test('task history redacts nested Redis history and task info without changing response shape', async () => {
  const database = await createHistoryDatabase();
  const previewPath = '/tmp/jobs/task-redis/.propr/previews/private.webp';
  const sourcePath = '/tmp/jobs/task-redis/.propr/preview-src/render.tsx';
  try {
    const redisClient = {
      get: async () => JSON.stringify({
        history: [{
          state: 'processing', timestamp: '2026-09-11T00:00:00.000Z',
          message: `Rendering ${previewPath}`,
          metadata: { detail: { sourcePath, complete: false }, count: 3 },
        }],
        issueRef: {
          repoOwner: 'acme', repoName: 'repo', number: 2283,
          title: `Preview ${previewPath}`,
          comments: [{ body: `Source ${sourcePath}`, resolved: true }],
          modelName: 'codex', agentAlias: 'codex',
        },
      }),
    } as unknown as RedisClientType;
    const routes = createTaskHistoryRoutes({ db: database, redisClient, taskQueue: {} as never });
    const recorder = responseRecorder();

    await routes.getTaskHistory({ params: { taskId: 'task-redis' } } as unknown as FlatRequest, recorder.response);

    const body = recorder.body() as {
      taskId: string;
      history: Array<{ metadata: { detail: { complete: boolean }; count: number } }>;
      taskInfo: { comments: Array<{ resolved: boolean }>; number: number };
    };
    assertRedacted(body, [previewPath, sourcePath]);
    assert.equal(body.taskId, 'task-redis');
    assert.equal(body.history[0].metadata.detail.complete, false);
    assert.equal(body.history[0].metadata.count, 3);
    assert.equal(body.taskInfo.number, 2283);
    assert.equal(body.taskInfo.comments[0].resolved, true);
  } finally {
    await database.destroy();
  }
});
