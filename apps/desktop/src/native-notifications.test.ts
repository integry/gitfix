import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
  NativeNotificationService,
  isDesktopNotificationScope,
  isDesktopTaskTransition,
  type NativeNotificationHandle,
  type NativeNotificationPayload,
} from './native-notifications';
import type { DesktopNotificationScope, DesktopTaskTransition } from './shared/contract';

const scope: DesktopNotificationScope = {
  profileId: 'profile-a',
  transportScope: 'abcdefghijklmnopqrstuv',
  userId: 'user-a',
};
const now = Date.parse('2026-09-07T18:45:00.000Z');
const transition = (
  state: string,
  previousState: string,
  taskId = 'task-a',
  version = 2,
): DesktopTaskTransition => ({
  taskId, state, previousState, repository: 'integry/propr', issueNumber: 2192,
  timestamp: new Date(now).toISOString(), version,
});

interface ShownNotification {
  payload: NativeNotificationPayload;
  click(): void;
  closed: boolean;
}

const fixture = async (overrides: { platform?: NodeJS.Platform; supported?: boolean } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-native-notifications-'));
  const shown: ShownNotification[] = [];
  const navigated: string[] = [];
  let active = true;
  let currentUser = scope.userId;
  const createService = () => new NativeNotificationService({
    statePath: join(directory, 'preferences.json'),
    platform: overrides.platform ?? 'linux',
    isSupported: () => overrides.supported ?? true,
    isActiveScope: candidate => active
      && candidate.profileId === scope.profileId
      && candidate.transportScope === scope.transportScope
      && candidate.userId === currentUser,
    show: (payload, click) => {
      const item: ShownNotification = { payload, click, closed: false };
      shown.push(item);
      const handle: NativeNotificationHandle = { close: () => { item.closed = true; } };
      return handle;
    },
    navigate: path => navigated.push(path),
    now: () => now,
    batchDelayMs: 5,
  });
  const service = createService();
  return {
    directory, service, shown, navigated,
    restart: createService,
    deactivate: () => { active = false; },
    setUser: (userId: string) => { currentUser = userId; },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
};

const settleBatch = () => new Promise(resolve => setTimeout(resolve, 15));

test('uses quiet defaults and persists account/instance/device preferences', async () => {
  const item = await fixture();
  try {
    const initial = await item.service.get(scope);
    assert.deepEqual(initial.preferences, DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES);
    assert.equal(initial.scope, 'account-instance-device');
    assert.equal(initial.capability.supported, true);

    const updated = await item.service.update(scope, { enabled: true, taskCompleted: true });
    assert.equal(updated.preferences.enabled, true);
    assert.equal(updated.preferences.taskStarted, false);
    assert.equal(updated.preferences.taskCompleted, true);
    await item.service.idle();
    const stored = JSON.parse(await readFile(join(item.directory, 'preferences.json'), 'utf8')) as {
      accounts: Record<string, { taskCompleted: boolean }>;
    };
    assert.equal(Object.values(stored.accounts)[0].taskCompleted, true);
    item.service.close();
    const restarted = item.restart();
    assert.equal((await restarted.get(scope)).preferences.taskCompleted, true);
    assert.equal((await restarted.get(scope)).preferences.enabled, true);
    restarted.close();
  } finally {
    await item.cleanup();
  }
});

test('reports Windows and missing native APIs without invoking delivery', async () => {
  const windows = await fixture({ platform: 'win32' });
  const unsupported = await fixture({ supported: false });
  try {
    assert.deepEqual((await windows.service.get(scope)).capability, {
      supported: false, platform: 'win32', permission: 'unsupported', reason: 'platform-deferred',
    });
    await windows.service.update(scope, { enabled: true });
    assert.equal((await windows.service.test(scope)).invoked, false);
    assert.equal((await unsupported.service.get(scope)).capability.reason, 'native-api-unavailable');
    const mac = new NativeNotificationService({
      statePath: join(windows.directory, 'mac.json'), platform: 'darwin',
      isSupported: () => true, isActiveScope: () => true,
      show: () => ({ close: () => undefined }), navigate: () => undefined,
    });
    assert.equal((await mac.get(scope)).capability.supported, true);
  } finally {
    await windows.cleanup();
    await unsupported.cleanup();
  }
});

test('honors every event toggle and suppresses snapshots, old events, and duplicate terminals', async () => {
  const item = await fixture();
  try {
    await item.service.update(scope, { enabled: true, taskStarted: true, taskCompleted: true });
    assert.equal((await item.service.publish(scope, transition('processing', 'queued'))).accepted, true);
    assert.equal((await item.service.publish(scope, transition('processing', 'queued'))).accepted, false);
    assert.equal((await item.service.publish(scope, transition('completed', 'processing', 'task-b'))).accepted, true);
    assert.equal((await item.service.publish(scope, transition('failed', 'processing', 'task-c'))).accepted, true);
    assert.equal((await item.service.publish(scope, transition('action_required', 'processing', 'task-d'))).accepted, true);
    assert.equal((await item.service.publish(scope, transition('completed', 'processing', 'task-b', 3))).accepted, false);
    assert.equal((await item.service.publish(scope, {
      ...transition('failed', 'processing', 'old-task'),
      timestamp: new Date(now - 180_000).toISOString(),
    })).accepted, false);
    assert.equal(isDesktopTaskTransition({ ...transition('completed', 'processing'), previousState: undefined }), false);
    await settleBatch();
    assert.equal(item.shown.length, 1);
    assert.equal(item.shown[0].payload.title, '4 task updates');
    assert.match(item.shown[0].payload.body, /1 failed/);
    assert.match(item.shown[0].payload.body, /1 need attention/);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('each event preference independently blocks its matching transition', async () => {
  const item = await fixture();
  try {
    await item.service.update(scope, {
      enabled: true,
      taskStarted: false,
      taskCompleted: false,
      taskFailed: false,
      taskNeedsAttention: false,
    });
    const cases = [
      transition('processing', 'queued', 'off-started'),
      transition('completed', 'processing', 'off-completed'),
      transition('failed', 'processing', 'off-failed'),
      transition('action_required', 'processing', 'off-attention'),
    ];
    for (const event of cases) {
      assert.equal((await item.service.publish(scope, event)).accepted, false);
    }
    await settleBatch();
    assert.equal(item.shown.length, 0);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('disable, stale scopes, and cleanup clear pending delivery immediately', async () => {
  const item = await fixture();
  try {
    await item.service.update(scope, { enabled: true, taskStarted: true });
    assert.equal((await item.service.publish(scope, transition('processing', 'queued'))).accepted, true);
    await item.service.update(scope, { enabled: false });
    await settleBatch();
    assert.equal(item.shown.length, 0);

    await item.service.update(scope, { enabled: true });
    item.deactivate();
    assert.equal((await item.service.publish(scope, transition('failed', 'processing', 'stale'))).accepted, false);
    assert.rejects(item.service.get(scope), /Stale desktop notification scope/);
    item.service.close();
  } finally {
    await item.cleanup();
  }
});

test('test and task clicks route only while the original scope remains authorized', async () => {
  const item = await fixture();
  try {
    await item.service.update(scope, { enabled: true });
    assert.equal((await item.service.test(scope)).invoked, true);
    item.shown[0].click();
    assert.deepEqual(item.navigated, ['/tasks']);

    assert.equal((await item.service.publish(scope, transition('failed', 'processing'))).accepted, true);
    await settleBatch();
    item.deactivate();
    item.shown[1].click();
    assert.deepEqual(item.navigated, ['/tasks']);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('account switches invalidate old pending clicks even when the transport scope is unchanged', async () => {
  const item = await fixture();
  const nextScope = { ...scope, userId: 'user-b' };
  try {
    await item.service.update(scope, { enabled: true });
    await item.service.test(scope);
    item.setUser('user-b');
    await item.service.get(nextScope);
    item.shown[0].click();
    assert.deepEqual(item.navigated, []);
    assert.equal(item.shown[0].closed, true);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('rate limits repeated small batches across the delivery window', async () => {
  const item = await fixture();
  try {
    await item.service.update(scope, { enabled: true });
    for (let index = 0; index < 7; index += 1) {
      assert.equal((await item.service.publish(
        scope, transition('failed', 'processing', `rate-${index}`, index + 2),
      )).accepted, true);
      await settleBatch();
    }
    assert.equal(item.shown.length, 6);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('rejects extra fields and malformed notification scopes at the native boundary', () => {
  assert.equal(isDesktopNotificationScope(scope), true);
  assert.equal(isDesktopNotificationScope({ ...scope, token: 'secret' }), false);
  assert.equal(isDesktopTaskTransition({ ...transition('failed', 'processing'), metadata: { output: 'no' } }), false);
  assert.equal(isDesktopTaskTransition({ ...transition('failed', 'processing'), repository: 'not-a-repo' }), false);
});
