import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Menu, MenuItemConstructorOptions, NativeImage, Tray } from 'electron';
import { createDesktopTrayController, formatTrayCount, parseActiveWorkSnapshot } from './system-tray';

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10));

const snapshot = (tasks: number, plans: number, openGoals: number): Response => Response.json({
  schemaVersion: 2,
  label: 'Active work',
  definition: 'Running tasks + generating or refining plans; open goals are reported separately',
  availability: {
    tasks: 'available',
    plans: 'available',
    goals: 'unsupported',
    openGoals: 'available',
  },
  counts: { tasks, plans, goals: null, openGoals, total: tasks + plans },
});

class FakeTray {
  destroyed = false;
  tooltip = '';
  title = '';
  menu: Menu | null = null;
  listeners = new Map<string, () => void>();
  popups = 0;

  on(event: string, listener: () => void): this {
    this.listeners.set(event, listener);
    return this;
  }

  setToolTip(value: string): void { this.tooltip = value; }
  setTitle(value: string): void { this.title = value; }
  setContextMenu(value: Menu | null): void { this.menu = value; }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; }
  popUpContextMenu(): void { this.popups += 1; }
}

const commandFixture = (dispatch: (command: string) => void = () => undefined) => ({
  dispatch,
  getState: () => ({
    authenticated: true,
    nativeNotificationsAvailable: true,
    nativeNotificationsEnabled: false,
  }),
  subscribe: () => () => undefined,
});

describe('desktop system tray', () => {
  it('validates active-only totals and formats bounded badge overflow', () => {
    assert.deepEqual(parseActiveWorkSnapshot({
      schemaVersion: 2,
      label: 'Active work',
      definition: 'definition',
      availability: { tasks: 'available', plans: 'available', goals: 'unsupported', openGoals: 'available' },
      counts: { tasks: 2, plans: 3, goals: null, openGoals: 40, total: 5 },
    }), { tasks: 2, plans: 3, goals: null, openGoals: 40, total: 5 });
    assert.equal(parseActiveWorkSnapshot({
      schemaVersion: 2,
      label: 'Active work',
      definition: 'definition',
      availability: { tasks: 'available', plans: 'available', goals: 'unsupported', openGoals: 'available' },
      counts: { tasks: 2, plans: 3, goals: null, openGoals: 40, total: 45 },
    }), null);
    assert.equal(formatTrayCount(0), '0');
    assert.equal(formatTrayCount(99), '99');
    assert.equal(formatTrayCount(100), '99+');
  });

  it('shows zero and nonzero counts, restores the window, quits explicitly, and cleans up once', async () => {
    const fakeTray = new FakeTray();
    let creates = 0;
    let opens = 0;
    let quits = 0;
    let next = snapshot(0, 0, 0);
    const badges: number[] = [];
    let menuTemplate: MenuItemConstructorOptions[] = [];
    const controller = createDesktopTrayController({
      platform: 'darwin',
      icon: {} as NativeImage,
      createTray: () => { creates += 1; return fakeTray as unknown as Tray; },
      buildMenu: template => { menuTemplate = template; return {} as Menu; },
      setBadgeCount: count => { badges.push(count); return true; },
      fetchActiveWork: async () => ({ status: 'response', response: next }),
      commands: commandFixture(command => {
        if (command === 'open') opens += 1;
        if (command === 'quit') quits += 1;
      }),
      log: () => undefined,
      debounceMs: 0,
      minimumRefreshIntervalMs: 0,
      pollIntervalMs: 60_000,
    });

    controller.start();
    controller.start();
    assert.equal(creates, 1, 'only one native tray is created');
    assert.match(fakeTray.tooltip, /unavailable/i);

    controller.connectionAvailable();
    await tick();
    assert.equal(fakeTray.title, '0');
    assert.match(fakeTray.tooltip, /Active work: 0/);
    assert.ok(menuTemplate.some(item => item.label === 'Tasks: 0'));

    next = snapshot(73, 25, 5);
    controller.refresh();
    await tick();
    assert.equal(fakeTray.title, '98');
    assert.match(fakeTray.tooltip, /Active work: 98/);
    assert.match(fakeTray.tooltip, /Open goals 5 \(not active\)/);
    assert.ok(menuTemplate.some(item => item.label === 'Plans: 25'));
    assert.ok(menuTemplate.some(item => item.label === 'Goals: Unsupported (no executing state)'));
    assert.ok(menuTemplate.some(item => item.label === 'Open goals (not active): 5'));
    assert.equal(badges.at(-1), 98);

    fakeTray.listeners.get('click')?.();
    assert.equal(fakeTray.popups, 1, 'primary activation opens the actionable menu');
    assert.ok(fakeTray.menu, 'the installed context menu supplies right-click activation');
    assert.equal(fakeTray.listeners.has('double-click'), false, 'macOS leaves double activation to native menu behavior');
    const openItem = menuTemplate.find(item => item.label === 'Open ProPR');
    (openItem?.click as (() => void) | undefined)?.();
    assert.equal(opens, 1, 'Open ProPR remains an explicit action');
    const quitItem = menuTemplate.find(item => item.label === 'Quit ProPR');
    (quitItem?.click as (() => void) | undefined)?.();
    assert.equal(quits, 1);

    controller.connectionUnavailable('revoked');
    assert.equal(fakeTray.title, '');
    assert.match(fakeTray.tooltip, /Access revoked/);
    assert.equal(badges.at(-1), 0);

    controller.close();
    controller.close();
    assert.equal(fakeTray.destroyed, true);
    assert.equal(badges.at(-1), 0);
  });

  it('cleans up a partially initialized tray and its poller before retrying safely', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const trays: FakeTray[] = [];
    let fetches = 0;
    let failInitialization = true;
    const controller = createDesktopTrayController({
      platform: 'linux',
      icon: {} as NativeImage,
      createTray: () => {
        const created = new FakeTray();
        trays.push(created);
        return created as unknown as Tray;
      },
      buildMenu: () => ({} as Menu),
      setBadgeCount: () => false,
      fetchActiveWork: async () => {
        fetches += 1;
        return { status: 'disconnected' };
      },
      commands: commandFixture(),
      log: (level) => {
        if (level === 'info' && failInitialization) {
          failInitialization = false;
          throw new Error('late initialization failure');
        }
      },
      debounceMs: 0,
      minimumRefreshIntervalMs: 0,
      pollIntervalMs: 100,
    });

    controller.start();
    assert.equal(trays.length, 1);
    assert.equal(trays[0]?.destroyed, true);

    t.mock.timers.tick(50);
    controller.start();
    assert.equal(trays.length, 2, 'a failed initialization can be retried');
    assert.equal(trays[1]?.destroyed, false);

    controller.connectionAvailable();
    t.mock.timers.tick(0);
    await Promise.resolve();
    assert.equal(fetches, 1);

    t.mock.timers.tick(50);
    t.mock.timers.tick(0);
    await Promise.resolve();
    assert.equal(fetches, 1, 'the failed initialization did not retain its polling timer');

    t.mock.timers.tick(50);
    t.mock.timers.tick(0);
    await Promise.resolve();
    assert.equal(fetches, 2, 'only the retried tray retains a polling timer');

    controller.close();
    assert.equal(trays[1]?.destroyed, true);
    t.mock.timers.tick(100);
    await Promise.resolve();
    assert.equal(fetches, 2);
  });

  it('opens once on a Linux double activation without dispatching from the primary click', () => {
    const fakeTray = new FakeTray();
    const dispatched: string[] = [];
    const controller = createDesktopTrayController({
      platform: 'linux',
      icon: {} as NativeImage,
      createTray: () => fakeTray as unknown as Tray,
      buildMenu: () => ({} as Menu),
      setBadgeCount: () => false,
      fetchActiveWork: async () => ({ status: 'disconnected' }),
      commands: commandFixture(command => dispatched.push(command)),
      log: () => undefined,
    });
    controller.start();
    fakeTray.listeners.get('click')?.();
    assert.deepEqual(dispatched, []);
    fakeTray.listeners.get('double-click')?.();
    assert.deepEqual(dispatched, ['open']);
    controller.close();
  });

  it('drops scoped stale responses and marks network failures unavailable instead of zero', async () => {
    const fakeTray = new FakeTray();
    let resolveFetch!: (value: { status: 'response'; response: Response }) => void;
    const pending = new Promise<{ status: 'response'; response: Response }>(resolve => { resolveFetch = resolve; });
    let request = 0;
    const controller = createDesktopTrayController({
      platform: 'linux',
      icon: {} as NativeImage,
      createTray: () => fakeTray as unknown as Tray,
      buildMenu: () => ({} as Menu),
      setBadgeCount: () => false,
      fetchActiveWork: async () => {
        request += 1;
        if (request === 1) return pending;
        throw new Error('offline');
      },
      commands: commandFixture(),
      log: () => undefined,
      debounceMs: 0,
      minimumRefreshIntervalMs: 0,
      pollIntervalMs: 60_000,
    });
    controller.start();
    controller.connectionAvailable();
    await tick();
    controller.connectionUnavailable('profile-changed');
    resolveFetch({ status: 'response', response: snapshot(9, 9, 9) });
    await tick();
    assert.match(fakeTray.tooltip, /Instance changed/);
    assert.doesNotMatch(fakeTray.tooltip, /Active work: 18/);

    controller.connectionAvailable();
    await tick();
    assert.match(fakeTray.tooltip, /Active work unavailable — Instance unavailable/);
    assert.doesNotMatch(fakeTray.tooltip, /Active work: 0/);
    controller.close();
  });

  it('uses no native tray on deferred platforms', () => {
    let created = false;
    const controller = createDesktopTrayController({
      platform: 'win32',
      icon: {} as NativeImage,
      createTray: () => { created = true; return {} as Tray; },
      buildMenu: () => ({} as Menu),
      setBadgeCount: () => false,
      fetchActiveWork: async () => ({ status: 'disconnected' }),
      commands: commandFixture(),
      log: () => undefined,
    });
    controller.start();
    assert.equal(created, false);
    controller.close();
  });
});
