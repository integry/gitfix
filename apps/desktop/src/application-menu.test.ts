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

  it('keeps macOS conventions and disables authenticated navigation', () => {
    const value = fixture({ authenticated: false, nativeNotificationsAvailable: false });
    const controller = configureApplicationMenu(value.host, value.commands, 'darwin');
    let all = items(value.template());
    assert.ok(all.some(item => item.role === 'about'));
    assert.ok(all.some(item => item.role === 'services'));
    assert.ok(all.some(item => item.role === 'close'));
    assert.equal(all.find(item => item.label === 'Quit ProPR')?.accelerator, 'CmdOrCtrl+Q');
    assert.equal(all.find(item => item.label === 'New Plan')?.enabled, false);
    assert.equal(all.find(item => item.label === 'Settings…')?.enabled, false);
    assert.equal(all.find(item => item.label === 'Back')?.enabled, false);
    assert.equal(value.listeners.size, 1);
    controller.close();
    assert.equal(value.listeners.size, 0);


  });


  it('organizes macOS actions and exposes unique shortcuts for actual app sections', () => {
    const value = fixture({ canGoBack: true, canGoForward: false, canManageInstances: false });
    configureApplicationMenu(value.host, value.commands, 'darwin');
    const template = value.template();
    assert.deepEqual(template.map(item => item.label), ['ProPR', 'File', 'Edit', 'View', 'Go', 'Window']);
    const all = items(template);
    const accelerators = all.flatMap(item => item.accelerator ? [item.accelerator] : []);
    assert.equal(new Set(accelerators).size, accelerators.length);
    const sections = ['Dashboard', 'Inbox', 'Plans', 'Goals', 'Tasks', 'Repositories', 'LLM Log'];
    sections.forEach((label, index) => {
      const item = all.find(item => item.label === label);
      assert.equal(item?.accelerator, `CmdOrCtrl+${index + 1}`);
      (item?.click as () => void)();
    });
    assert.deepEqual(value.dispatched, ['dashboard', 'inbox', 'plans', 'goals', 'tasks', 'repositories', 'llm-logs']);
    assert.equal(all.find(item => item.label === 'Settings…')?.accelerator, 'CmdOrCtrl+,');
    assert.equal(all.find(item => item.label === 'Back')?.enabled, true);
    assert.equal(all.find(item => item.label === 'Forward')?.enabled, false);
    assert.equal(all.find(item => item.label === 'Switch / Manage Instances…')?.enabled, false);
    assert.equal(all.filter(item => item.role === 'close').length, 1);
    assert.ok(!all.some(item => ['Open ProPR', 'Notification Settings…', 'Resume Native Notifications'].includes(item.label ?? '')));
    assert.ok((template[1].submenu as MenuItemConstructorOptions[]).some(item => item.label === 'New Plan'));
  });

  it('leaves the deferred Windows application menu untouched', () => {
    const value = fixture();
    configureApplicationMenu(value.host, value.commands, 'win32');
    assert.deepEqual(value.template(), []);
  });
});
