import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Knex } from 'knex';
import type { Notification } from '@propr/shared';
import {
  VoiceBriefingService,
  createVoiceBriefingDataLoaders,
  type VoiceBriefingDataLoaders,
  type VoiceBriefingPlanRow,
  type VoiceBriefingQueueJob,
  type VoiceBriefingQueueSnapshot,
} from '../services/voiceBriefingService.js';

const NOW = '2026-09-07T01:30:00.000Z';

function job(
  id: string,
  title: string,
  timestamp: string,
  extraData: Record<string, unknown> = {},
): VoiceBriefingQueueJob {
  return {
    id,
    name: 'task',
    timestamp: Date.parse(timestamp),
    data: {
      taskId: id,
      title,
      repository: 'integry/propr',
      ...extraData,
    },
  } as VoiceBriefingQueueJob;
}

function notification(input: {
  id: string;
  severity: 'warning' | 'error';
  title: string;
  target: Notification['target'];
  occurredAt: string;
  actions?: Notification['actions'];
  body?: string;
  metadata?: Record<string, string>;
}): Notification {
  return {
    id: input.id,
    deduplicationKey: `dedupe-${input.id}`,
    kind: input.target.type,
    severity: input.severity,
    target: input.target,
    title: input.title,
    body: input.body ?? 'Notification body must not enter the briefing',
    actions: input.actions ?? [],
    metadata: input.metadata,
    occurredAt: input.occurredAt,
    createdAt: input.occurredAt,
    readAt: null,
    dismissedAt: null,
  } as Notification;
}

function loaders(input: {
  queue: VoiceBriefingQueueSnapshot;
  plans?: VoiceBriefingPlanRow[];
  notifications?: Notification[];
}): VoiceBriefingDataLoaders {
  return {
    loadQueueJobs: async () => input.queue,
    loadPlans: async () => input.plans ?? [],
    loadNotifications: async () => input.notifications ?? [],
  };
}

test('briefing preserves complete job counts, prioritizes attention, deduplicates tasks, and caps details at eight', async () => {
  const queue: VoiceBriefingQueueSnapshot = {
    active: [
      job('task-1', 'Implement voice briefing', '2026-09-07T01:20:00.000Z', {
        prompt: 'SECRET PROMPT',
        toolOutput: 'SECRET TOOL OUTPUT',
      }),
      job('task-2', 'Update queue status', '2026-09-07T01:19:00.000Z'),
      job('task-3', 'Add parser validation', '2026-09-07T01:18:00.000Z'),
      job('task-4', 'Check navigation', '2026-09-07T01:17:00.000Z'),
      job('task-5', 'Write documentation', '2026-09-07T01:16:00.000Z'),
    ],
    waiting: [
      job('task-6', 'Queued one', '2026-09-07T01:15:00.000Z'),
      job('task-7', 'Queued two', '2026-09-07T01:14:00.000Z'),
      job('task-8', 'Queued three', '2026-09-07T01:13:00.000Z'),
    ],
    delayed: [
      job('task-9', 'Delayed one', '2026-09-07T01:12:00.000Z'),
      job('task-10', 'Delayed two', '2026-09-07T01:11:00.000Z'),
    ],
  };
  const plans: VoiceBriefingPlanRow[] = [{
    draft_id: 'draft-1',
    name: 'Secure voice workflow',
    repository: 'integry/propr',
    status: 'review',
    updated_at: '2026-09-07T01:10:00.000Z',
    initial_prompt: 'SECRET PLAN PROMPT',
  } as VoiceBriefingPlanRow];
  const notifications = [
    notification({
      id: 'notification-error',
      severity: 'error',
      title: 'Voice task failed',
      target: { type: 'task', repository: 'integry/propr', taskId: 'task-1' },
      occurredAt: '2026-09-07T01:05:00.000Z',
      actions: ['stop', 'follow_up'],
      body: 'SECRET LOG OUTPUT',
      metadata: { credential: 'SECRET CREDENTIAL' },
    }),
    notification({
      id: 'notification-warning',
      severity: 'warning',
      title: 'Worker needs attention',
      target: { type: 'system_failure', component: 'worker' },
      occurredAt: '2026-09-07T01:04:00.000Z',
    }),
  ];
  const service = new VoiceBriefingService({
    loaders: loaders({ queue, plans, notifications }),
    now: () => NOW,
  });

  const first = await service.getBriefing('user-1');
  const second = await service.getBriefing('user-1');

  assert.deepEqual(first.counts, {
    running: 5,
    queued: 5,
    attention: 3,
    plans: 1,
    total: 12,
  });
  assert.equal(first.items.length, 8);
  assert.deepEqual(first.items.slice(0, 3).map(item => item.status), [
    'error',
    'warning',
    'review',
  ]);
  assert.deepEqual(first.items.slice(0, 3).map(item => item.reference), [
    'task 1',
    'system 1',
    'plan 1',
  ]);
  assert.equal(first.items.filter(item => item.id === 'task-1').length, 1);
  assert.deepEqual(second.items, first.items, 'the same snapshot has stable reference ordering');

  const serialized = JSON.stringify(first);
  for (const secret of [
    'SECRET PROMPT',
    'SECRET TOOL OUTPUT',
    'SECRET PLAN PROMPT',
    'SECRET LOG OUTPUT',
    'SECRET CREDENTIAL',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('running and attention scopes filter details while retaining complete snapshot counts', async () => {
  const requestedPlanUsers: string[] = [];
  const requestedNotificationUsers: string[] = [];
  const queue: VoiceBriefingQueueSnapshot = {
    active: [job('active-task', 'Active task', '2026-09-07T01:20:00.000Z')],
    waiting: [job('queued-task', 'Queued task', '2026-09-07T01:19:00.000Z')],
    delayed: [],
  };
  const testLoaders: VoiceBriefingDataLoaders = {
    loadQueueJobs: async () => queue,
    loadPlans: async userId => {
      requestedPlanUsers.push(userId);
      return [
        {
          draft_id: 'generating-plan', name: 'Generating plan', repository: 'integry/propr',
          status: 'generating', updated_at: '2026-09-07T01:18:00.000Z',
        },
        {
          draft_id: 'review-plan', name: 'Review plan', repository: 'integry/propr',
          status: 'review', updated_at: '2026-09-07T01:17:00.000Z',
        },
        {
          draft_id: 'approved-plan', name: 'Approved plan', repository: 'integry/propr',
          status: 'approved', updated_at: '2026-09-07T01:16:00.000Z',
        },
      ];
    },
    loadNotifications: async userId => {
      requestedNotificationUsers.push(userId);
      return [notification({
        id: 'warning-1',
        severity: 'warning',
        title: 'Task is stalled',
        target: { type: 'task', repository: 'integry/propr', taskId: 'stalled-task' },
        occurredAt: '2026-09-07T01:15:00.000Z',
      })];
    },
  };
  const service = new VoiceBriefingService({ loaders: testLoaders, now: () => NOW });

  const running = await service.getBriefing('authenticated-user', 'running');
  const attention = await service.getBriefing('authenticated-user', 'attention');

  assert.deepEqual(running.items.map(item => item.id), ['active-task', 'generating-plan']);
  assert.deepEqual(attention.items.map(item => item.id), ['stalled-task', 'review-plan']);
  assert.ok(attention.items.every(item => item.requiresAttention));
  assert.deepEqual(running.counts, attention.counts);
  assert.deepEqual(requestedPlanUsers, ['authenticated-user', 'authenticated-user']);
  assert.deepEqual(requestedNotificationUsers, ['authenticated-user', 'authenticated-user']);
});

test('production loaders constrain the plan query and page through recipient-authorized notifications', async () => {
  const queryTrace: Array<[string, unknown]> = [];
  const planRows = [{
    draft_id: 'owned-plan', name: 'Owned plan', repository: 'integry/propr',
    status: 'review', updated_at: NOW,
  }];
  const query = {
    select(...columns: string[]) {
      queryTrace.push(['select', columns]);
      return this;
    },
    where(value: unknown) {
      queryTrace.push(['where', value]);
      return this;
    },
    whereIn(column: string, values: readonly string[]) {
      queryTrace.push(['whereIn', [column, values]]);
      return Promise.resolve(planRows);
    },
  };
  const database = ((table: string) => {
    queryTrace.push(['table', table]);
    return query;
  }) as unknown as Knex;
  const queueStates: string[][] = [];
  const taskQueue = {
    async getJobs(states: string[]) {
      queueStates.push(states);
      return [];
    },
  };
  const notificationCalls: Array<{ userId: string; cursor: string | null; limit?: number }> = [];
  const notificationService = {
    async listNotifications(userId: string, options: { cursor?: string | null; limit?: number }) {
      notificationCalls.push({
        userId,
        cursor: options.cursor ?? null,
        limit: options.limit,
      });
      return {
        notifications: [],
        unreadCount: 0,
        nextCursor: options.cursor === null ? 'next-page' : null,
      };
    },
  };
  const dataLoaders = createVoiceBriefingDataLoaders({
    database,
    taskQueue: taskQueue as never,
    notificationService,
  });

  const [snapshot, loadedPlans, loadedNotifications] = await Promise.all([
    dataLoaders.loadQueueJobs(),
    dataLoaders.loadPlans('owner-user'),
    dataLoaders.loadNotifications('owner-user'),
  ]);

  assert.deepEqual(snapshot, { active: [], waiting: [], delayed: [] });
  assert.deepEqual(queueStates, [['active'], ['waiting'], ['delayed']]);
  assert.deepEqual(loadedPlans, planRows);
  assert.deepEqual(loadedNotifications, []);
  assert.deepEqual(queryTrace, [
    ['table', 'task_drafts'],
    ['select', ['draft_id', 'name', 'repository', 'status', 'updated_at']],
    ['where', { user_id: 'owner-user' }],
    ['whereIn', ['status', ['generating', 'executing', 'review', 'approved']]],
  ]);
  assert.deepEqual(notificationCalls, [
    { userId: 'owner-user', cursor: null, limit: 100 },
    { userId: 'owner-user', cursor: 'next-page', limit: 100 },
  ]);
});
