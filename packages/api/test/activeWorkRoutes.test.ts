import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Request, Response as ExpressResponse } from 'express';
import knex, { type Knex } from 'knex';
import type { CommentJobData, IssueJobData } from '@propr/core';
import type { InstanceAuthorization } from '../authorization.js';
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

const instanceAuthorization: InstanceAuthorization = {
  role: 'member',
  permissions: [],
  source: 'managed',
};

const authorizedRequest = (userId: string): Request => ({
  user: { id: userId },
  authorization: instanceAuthorization,
} as Request);

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
          { id: 'task-1', data: { repoOwner: 'integry', repoName: 'propr', number: 2191 } },
          { id: 'task-2', data: { repoOwner: 'integry', repoName: 'propr', number: 2192 } },
          { id: 'task-1', data: { repoOwner: 'integry', repoName: 'propr', number: 2191 } },
          { id: undefined, data: { repoOwner: 'integry', repoName: 'propr', number: 2193 } },
        ] as never;
      },
    } as never,
  });
  const recorded = responseRecorder();

  await routes.getActiveWork(authorizedRequest('user-a'), recorded.response);

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

test('authorized instance account sees canonical active jobs and unresolved accounts stay isolated', async () => {
  await database('task_drafts').del();
  await database('repo_todos').del();
  const issueJobData: IssueJobData = {
    repoOwner: 'integry',
    repoName: 'propr',
    number: 2191,
    agentAlias: 'codex',
    modelName: 'gpt-5.6-sol',
    correlationId: 'issue-correlation',
  };
  const commentJobData: CommentJobData = {
    pullRequestNumber: 2196,
    comments: [{ id: 501, body: 'Please apply the follow-up', author: 'integry', type: 'issue' }],
    repoOwner: 'integry',
    repoName: 'propr',
    branchName: '2191/system-tray',
    llm: 'gpt-5.6-sol',
    correlationId: 'comment-correlation',
  };
  assert.equal('userId' in issueJobData, false);
  assert.equal('userId' in commentJobData, false);
  const jobs = [
    { id: 'issue-integry-propr-2191-codex-gpt-5.6-sol', data: issueJobData },
    { id: 'pr-comments-batch-integry-propr-2196-501', data: commentJobData },
    { id: 'issue-integry-propr-2191-codex-gpt-5.6-sol', data: issueJobData },
  ];
  let queueReads = 0;
  const routes = createActiveWorkRoutes({
    db: database,
    taskQueue: { getJobs: async () => { queueReads += 1; return jobs; } } as never,
  });

  const authorized = responseRecorder();
  await routes.getActiveWork(authorizedRequest('authorized-user'), authorized.response);

  assert.equal(authorized.status(), 200);
  assert.equal(queueReads, 1);
  assert.deepEqual((authorized.body().counts as Record<string, unknown>).tasks, 2);

  const unresolvedAccount = responseRecorder();
  await routes.getActiveWork(
    { user: { id: 'account-without-resolved-instance-access' } } as Request,
    unresolvedAccount.response,
  );

  assert.equal(unresolvedAccount.status(), 403);
  assert.deepEqual(unresolvedAccount.body(), { error: 'Instance access required' });
  assert.equal(queueReads, 1);
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
    await routes.getActiveWork(authorizedRequest('user-a'), recorded.response);
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
