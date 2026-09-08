import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from 'bullmq';

let exactLiveness: 'running' | 'stopped' | 'not_found' | 'unavailable' = 'not_found';
let legacyLiveness: 'running' | 'not_found' | 'unavailable' = 'not_found';
const queueAdd = mock.fn(async () => ({ id: 'replacement-task-2' }));

await mock.module('@propr/core', {
    namedExports: {
        inspectTaskContainerLivenessForTask: mock.fn(async () => ({
            liveness: exactLiveness,
            container: exactLiveness === 'running' || exactLiveness === 'stopped'
                ? { id: 'container-1', name: 'codex-task-old' }
                : null,
        })),
        inspectLegacyDockerContainerLivenessForTask: mock.fn(async () => legacyLiveness),
        issueQueue: { add: queueAdd },
        TaskStates: { PENDING: 'pending', CANCELLED: 'cancelled' },
        getPendingPrCommentsKey: (owner: string, repo: string, pr: number) => `pending-pr-comments:${owner}:${repo}:${pr}`,
    },
});

const {
    inspectPRCommentContainerCollision,
    isContainerCollisionCancellation,
    schedulePRCommentRecovery,
} = await import('../src/jobs/prCommentCollisionRecovery.js');

describe('PR comment container collision recovery', () => {
    test('continues past stopped containers but defers live and unavailable inspection', async () => {
        exactLiveness = 'stopped';
        legacyLiveness = 'not_found';
        assert.equal(await inspectPRCommentContainerCollision(['attempt-1']), null);

        exactLiveness = 'running';
        const running = await inspectPRCommentContainerCollision(['attempt-1']);
        assert.equal(running?.inspection.liveness, 'running');
        assert.equal(running?.source, 'exact-label');

        exactLiveness = 'unavailable';
        const unavailable = await inspectPRCommentContainerCollision(['attempt-1']);
        assert.equal(unavailable?.inspection.liveness, 'unavailable');
    });

    test('distinguishes collision cancellation from user cancellation', () => {
        const state = (reason: string) => ({
            state: 'cancelled',
            history: [{ state: 'cancelled', reason }],
        });
        assert.equal(isContainerCollisionCancellation(state('agent_container_already_running') as never), true);
        assert.equal(isContainerCollisionCancellation(state('Task cancelled by user') as never), false);
    });

    test('restores the claim, delays a fenced replacement, and preserves cancellation ownership', async () => {
        queueAdd.mock.resetCalls();
        const pending = new Map<string, string[]>();
        const redis = {
            async lrange(key: string) { return [...(pending.get(key) ?? [])]; },
            async lpush(key: string, ...values: string[]) {
                const list = pending.get(key) ?? [];
                for (const value of values) list.unshift(value);
                pending.set(key, list);
                return list.length;
            },
            async expire() { return 1; },
        };
        const states = new Map<string, { state: string }>([['cancelled-task-1', { state: 'cancelled' }]]);
        const created: string[] = [];
        const updates: Array<{ taskId: string; state: string; metadata: Record<string, unknown> }> = [];
        const stateManager = {
            async getTaskState(taskId: string) { return states.get(taskId) ?? null; },
            async createTaskState(taskId: string) {
                created.push(taskId);
                states.set(taskId, { state: 'pending' });
            },
            async updateTaskState(taskId: string, state: string, metadata: Record<string, unknown>) {
                updates.push({ taskId, state, metadata });
                states.set(taskId, { state });
            },
        };
        const logger = { info: mock.fn(), warn: mock.fn() };
        const comment = { id: 2228, body: 'preserve me', author: 'alice', type: 'issue' as const };
        const job = {
            id: 'cancelled-task-1',
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'acme',
                repoName: 'web',
                correlationId: 'correlation-1',
                comments: [],
            },
        } as Job;

        const replacementTaskId = await schedulePRCommentRecovery({
            job: job as never,
            taskId: 'cancelled-task-1',
            stateManager: stateManager as never,
            redisClient: redis as never,
            pickedUpComments: [comment],
            delay: 60000,
            reason: 'agent_container_already_running',
            correlatedLogger: logger as never,
            containerCollisionTaskId: 'cancelled-task-1',
        });

        assert.equal(replacementTaskId, 'replacement-task-2');
        assert.equal(queueAdd.mock.calls[0].arguments[2]?.delay, 60000);
        assert.equal(queueAdd.mock.calls[0].arguments[1].containerCollisionTaskId, 'cancelled-task-1');
        assert.deepStrictEqual(
            (pending.get('pending-pr-comments:acme:web:42') ?? []).map(value => JSON.parse(value).id),
            [2228],
        );
        assert.deepStrictEqual(created, ['replacement-task-2']);
        assert.equal(states.get('cancelled-task-1')?.state, 'cancelled', 'the terminal attempt is never reopened');
        const originalUpdate = updates.find(update => update.taskId === 'cancelled-task-1');
        assert.equal(originalUpdate?.state, 'cancelled');
        assert.equal(
            (originalUpdate?.metadata.historyMetadata as Record<string, unknown>).replacementTaskId,
            'replacement-task-2',
        );
    });
});
