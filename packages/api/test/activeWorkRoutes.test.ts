import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Request, Response as ExpressResponse } from 'express';
import knex, { type Knex } from 'knex';
import { createActiveWorkRoutes, ACTIVE_WORK_DEFINITION } from '../routes/activeWorkRoutes.js';

let database: Knex;

before(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('task_drafts', table => {
    table.text('draft_id').primary();
    table.text('user_id').notNullable();
    table.text('status').notNullable();
  });
  await database.schema.createTable('repo_todos', table => {
    table.text('todo_id').primary();
    table.text('user_id').notNullable();
    table.boolean('is_completed').notNullable();
    table.text('linked_draft_id').nullable();
  });
});

after(async () => database.destroy());

const responseRecorder = (): {
  response: ExpressResponse;
  status: () => number;
  body: () => Record<string, unknown>;
} => {
  let statusCode = 200;
  let body: Record<string, unknown> = {};
  const response = {
    status(code: number) { statusCode = code; return response; },
    json(value: Record<string, unknown>) { body = value; return response; },
  } as unknown as ExpressResponse;
  return { response, status: () => statusCode, body: () => body };
};

test('idle goal backlog is reported as open and cannot inflate active work', async () => {
  await database('task_drafts').del();
  await database('repo_todos').del();
  await database('task_drafts').insert([
    { draft_id: 'generating-a', user_id: 'user-a', status: 'generating' },
    { draft_id: 'refining-a', user_id: 'user-a', status: 'refining' },
    { draft_id: 'review-a', user_id: 'user-a', status: 'review' },
    { draft_id: 'generating-b', user_id: 'user-b', status: 'generating' },
  ]);
  await database('repo_todos').insert([
    { todo_id: 'standalone-a', user_id: 'user-a', is_completed: false, linked_draft_id: null },
    { todo_id: 'standalone-a-2', user_id: 'user-a', is_completed: false, linked_draft_id: null },
    { todo_id: 'linked-a', user_id: 'user-a', is_completed: false, linked_draft_id: 'generating-a' },
    { todo_id: 'completed-a', user_id: 'user-a', is_completed: true, linked_draft_id: null },
    { todo_id: 'standalone-b', user_id: 'user-b', is_completed: false, linked_draft_id: null },
  ]);
  const requestedStates: string[][] = [];
  const routes = createActiveWorkRoutes({
    db: database,
    taskQueue: {
      getJobs: async (states: string[]) => {
        requestedStates.push(states);
        return [
          { id: 'task-1', data: { userId: 'user-a' } },
          { id: 'task-2', data: { userId: 'user-a' } },
          { id: 'task-1', data: { userId: 'user-a' } },
          { id: undefined, data: { userId: 'user-a' } },
        ] as never;
      },
    } as never,
  });
  const recorded = responseRecorder();

  await routes.getActiveWork({ user: { id: 'user-a' } } as Request, recorded.response);

  assert.equal(recorded.status(), 200);
  assert.deepEqual(requestedStates, [['active']]);
  assert.deepEqual(recorded.body(), {
    schemaVersion: 2,
    label: 'Active work',
    definition: ACTIVE_WORK_DEFINITION,
    availability: {
      tasks: 'available',
      plans: 'available',
      goals: 'unsupported',
      openGoals: 'available',
    },
    counts: { tasks: 2, plans: 2, goals: null, openGoals: 2, total: 4 },
  });
});

test('active queue jobs are scoped to the authenticated account', async () => {
  await database('task_drafts').del();
  await database('repo_todos').del();
  const jobs = [
    { id: 'task-a-1', data: { userId: 'user-a' } },
    { id: 'task-a-2', data: { userId: 'user-a' } },
    { id: 'task-a-1', data: { userId: 'user-a' } },
    { id: 'task-b', data: { userId: 'user-b' } },
    { id: 'forged-owner', data: { ownerId: 'user-a' } },
    { id: 'unowned', data: {} },
  ];
  const routes = createActiveWorkRoutes({
    db: database,
    taskQueue: { getJobs: async () => jobs } as never,
  });

  const userA = responseRecorder();
  await routes.getActiveWork({ user: { id: 'user-a' } } as Request, userA.response);
  const userB = responseRecorder();
  await routes.getActiveWork({ user: { id: 'user-b' } } as Request, userB.response);

  assert.equal(userA.status(), 200);
  assert.equal(userB.status(), 200);
  assert.deepEqual((userA.body().counts as Record<string, unknown>).tasks, 2);
  assert.deepEqual((userB.body().counts as Record<string, unknown>).tasks, 1);
});

test('active work does not present unavailable data as a verified zero', async () => {
  const routes = createActiveWorkRoutes({
    db: database,
    taskQueue: { getJobs: async () => { throw new Error('queue offline'); } } as never,
  });
  const recorded = responseRecorder();
  const previousError = console.error;
  console.error = () => undefined;
  try {
    await routes.getActiveWork({ user: { id: 'user-a' } } as Request, recorded.response);
  } finally {
    console.error = previousError;
  }
  assert.equal(recorded.status(), 500);
  assert.deepEqual(recorded.body(), { error: 'Failed to fetch active work' });
});

test('active work rejects a missing authenticated account', async () => {
  const routes = createActiveWorkRoutes({ db: database, taskQueue: { getJobs: async () => [] } as never });
  const recorded = responseRecorder();
  await routes.getActiveWork({} as Request, recorded.response);
  assert.equal(recorded.status(), 401);
});
