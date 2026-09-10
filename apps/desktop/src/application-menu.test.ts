import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Menu, MenuItemConstructorOptions } from 'electron';
import { configureApplicationMenu } from './application-menu';
import type { DesktopNativeCommandDispatcher } from './native-commands';

const fixture = (overrides: Partial<ReturnType<DesktopNativeCommandDispatcher['getState']>> = {}) => {
  const dispatched: string[] = [];
  const listeners = new Set<() => void>();
  let template: MenuItemConstructorOptions[] = [];
  const commands = {
    dispatch: (command: string) => { dispatched.push(command); },
    getState: () => ({
      authenticated: true,
      nativeNotificationsAvailable: true,
      nativeNotificationsEnabled: false,
      ...overrides,
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    rendererReady: () => undefined,
    rendererUnavailable: () => undefined,
    connectionAvailable: () => undefined,
    connectionUnavailable: () => undefined,
    refresh: () => undefined,
    close: () => undefined,
  } satisfies DesktopNativeCommandDispatcher;
  const host = {
    buildFromTemplate(value: MenuItemConstructorOptions[]) { template = value; return {} as Menu; },
    setApplicationMenu() { /* captured by buildFromTemplate */ },
  };
  return { commands, dispatched, listeners, host, template: () => template };
};

const items = (template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => template.flatMap(item => [
  item,
  ...(Array.isArray(item.submenu) ? item.submenu : []),
]);

describe('desktop application menu', () => {
  it('installs task-oriented Linux commands with discoverable accelerators', () => {
    const value = fixture();
    configureApplicationMenu(value.host, value.commands, 'linux');
    const all = items(value.template());
    for (const [label, accelerator] of [
      ['New Plan', 'CmdOrCtrl+N'], ['Tasks', 'CmdOrCtrl+1'], ['Plans', 'CmdOrCtrl+2'],
      ['Inbox', 'CmdOrCtrl+3'], ['Switch / Manage Instances…', 'CmdOrCtrl+Shift+I'],
      ['Notification Settings…', 'CmdOrCtrl+,'],
    ]) {
      assert.equal(all.find(item => item.label === label)?.accelerator, accelerator);
    }
    assert.deepEqual(
      all.filter(item => item.accelerator === 'CmdOrCtrl+,').map(item => item.label),
      ['Notification Settings…'],
    );
    (all.find(item => item.label === 'Tasks')?.click as (() => void))();
    assert.deepEqual(value.dispatched, ['tasks']);
    assert.ok(all.some(item => item.role === 'copy'));
    assert.ok(all.some(item => item.role === 'zoomIn'));
  });

  it('keeps macOS conventions and synchronizes notification/auth state', () => {
    const value = fixture({ authenticated: false, nativeNotificationsAvailable: false });
    const controller = configureApplicationMenu(value.host, value.commands, 'darwin');
    let all = items(value.template());
    assert.ok(all.some(item => item.role === 'about'));
    assert.ok(all.some(item => item.role === 'services'));
    assert.ok(all.some(item => item.role === 'close'));
    assert.equal(all.find(item => item.label === 'Quit ProPR')?.accelerator, 'CmdOrCtrl+Q');
    assert.equal(all.find(item => item.label === 'New Plan')?.enabled, false);
    assert.equal(all.find(item => item.label === 'Resume Native Notifications')?.enabled, false);
    assert.equal(all.find(item => item.label === 'Resume Native Notifications')?.checked, false);
    assert.equal(value.listeners.size, 1);
    controller.close();
    assert.equal(value.listeners.size, 0);

    const enabled = fixture({ nativeNotificationsEnabled: true });
    configureApplicationMenu(enabled.host, enabled.commands, 'darwin');
    const toggle = items(enabled.template()).find(item => item.label === 'Pause Native Notifications');
    assert.equal(toggle?.type, 'checkbox');
    assert.equal(toggle?.checked, true);
  });

  it('leaves the deferred Windows application menu untouched', () => {
    const value = fixture();
    configureApplicationMenu(value.host, value.commands, 'win32');
    assert.deepEqual(value.template(), []);
  });
});
