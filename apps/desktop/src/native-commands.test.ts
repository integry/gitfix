import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDesktopNativeCommandDispatcher } from './native-commands';

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('desktop native command dispatcher', () => {
  it('restores a hidden window, gates auth actions, and delivers only fixed renderer commands when ready', () => {
    const sent: string[] = [];
    let restores = 0;
    let scope: { profileId: string; transportScope: string } | null = null;
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'desktop:native-command',
      getWindow: () => ({ isDestroyed: () => false, webContents: { send: (_channel, value) => sent.push(value) } }),
      restoreWindow: () => { restores += 1; },
      activeConnectionScope: () => scope,
      notificationState: () => ({ available: false, enabled: false }),
      setNativeNotificationsEnabled: async () => undefined,
      quit: () => undefined,
    });
    dispatcher.rendererReady();
    dispatcher.dispatch('tasks');
    assert.deepEqual(sent, []);
    assert.equal(restores, 0);

    scope = { profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv' };
    dispatcher.connectionAvailable();
    dispatcher.dispatch('tasks');
    dispatcher.dispatch('manage-instances');
    assert.deepEqual(sent, ['tasks', 'manage-instances']);
    assert.equal(restores, 2);
  });

  it('queues startup navigation but drops it after an instance switch', () => {
    const sent: string[] = [];
    let scope = { profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv' };
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'desktop:native-command',
      getWindow: () => ({ isDestroyed: () => false, webContents: { send: (_channel, value) => sent.push(value) } }),
      restoreWindow: () => undefined,
      activeConnectionScope: () => scope,
      notificationState: () => ({ available: false, enabled: false }),
      setNativeNotificationsEnabled: async () => undefined,
      quit: () => undefined,
    });
    dispatcher.connectionAvailable();
    dispatcher.dispatch('plans');
    scope = { profileId: 'profile-b', transportScope: 'zyxwvutsrqponmlkjihgfe' };
    dispatcher.rendererReady();
    assert.deepEqual(sent, []);
    dispatcher.dispatch('inbox');
    assert.deepEqual(sent, ['inbox']);
  });

  it('flushes to the exact recreated window before its global reference is published', () => {
    const sent: string[] = [];
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'desktop:native-command',
      getWindow: () => null,
      restoreWindow: () => undefined,
      activeConnectionScope: () => ({ profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv' }),
      notificationState: () => ({ available: false, enabled: false }),
      setNativeNotificationsEnabled: async () => undefined,
      quit: () => undefined,
    });
    dispatcher.connectionAvailable();
    dispatcher.dispatch('new-plan');
    dispatcher.rendererReady({
      isDestroyed: () => false,
      webContents: { send: (_channel, command) => sent.push(command) },
    });
    assert.deepEqual(sent, ['new-plan']);
  });

  it('persists notification pause/resume, publishes state changes, and disposes commands', async () => {
    let enabled = true;
    let updates = 0;
    let quits = 0;
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'desktop:native-command',
      getWindow: () => null,
      restoreWindow: () => undefined,
      activeConnectionScope: () => ({ profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv' }),
      notificationState: () => ({ available: true, enabled }),
      setNativeNotificationsEnabled: async value => { enabled = value; },
      quit: () => { quits += 1; },
    });
    dispatcher.connectionAvailable();
    const unsubscribe = dispatcher.subscribe(() => { updates += 1; });
    assert.equal(dispatcher.getState().nativeNotificationsEnabled, true);
    dispatcher.dispatch('toggle-native-notifications');
    await tick();
    assert.equal(enabled, false);
    assert.equal(updates, 1);
    dispatcher.dispatch('quit');
    assert.equal(quits, 1);

    dispatcher.close();
    dispatcher.dispatch('quit');
    dispatcher.dispatch('toggle-native-notifications');
    await tick();
    assert.equal(quits, 1);
    assert.equal(updates, 1);
    unsubscribe();
  });
});
