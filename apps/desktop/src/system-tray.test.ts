import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Menu, MenuItemConstructorOptions, NativeImage, Tray } from 'electron';
import { createDesktopTrayController, formatTrayCount, parseActiveWorkSnapshot } from './system-tray';

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10));

const snapshot = (tasks: number, plans: number, goals: number): Response => Response.json({
  schemaVersion: 1,
  label: 'Active work',
  definition: 'Running tasks + generating or refining plans + standalone incomplete goals',
  counts: { tasks, plans, goals, total: tasks + plans + goals },
});

class FakeTray {
  destroyed = false;
  tooltip = '';
  title = '';
  menu: Menu | null = null;
  click: (() => void) | null = null;

  on(event: string, listener: () => void): this {
    if (event === 'click') this.click = listener;
    return this;
  }

  setToolTip(value: string): void { this.tooltip = value; }
  setTitle(value: string): void { this.title = value; }
  setContextMenu(value: Menu | null): void { this.menu = value; }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; }
}

describe('desktop system tray', () => {
  it('validates disjoint totals and formats bounded badge overflow', () => {
    assert.deepEqual(parseActiveWorkSnapshot({
      schemaVersion: 1,
      label: 'Active work',
      definition: 'definition',
      counts: { tasks: 2, plans: 3, goals: 4, total: 9 },
    }), { tasks: 2, plans: 3, goals: 4, total: 9 });
    assert.equal(parseActiveWorkSnapshot({
      schemaVersion: 1,
      label: 'Active work',
      definition: 'definition',
      counts: { tasks: 2, plans: 3, goals: 4, total: 10 },
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
      openWindow: () => { opens += 1; },
      quit: () => { quits += 1; },
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
    assert.equal(fakeTray.title, '99+');
    assert.match(fakeTray.tooltip, /Active work: 103/);
    assert.ok(menuTemplate.some(item => item.label === 'Plans: 25'));
    assert.equal(badges.at(-1), 103);

    fakeTray.click?.();
    assert.equal(opens, 1);
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
      openWindow: () => undefined,
      quit: () => undefined,
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
    assert.doesNotMatch(fakeTray.tooltip, /Active work: 27/);

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
      openWindow: () => undefined,
      quit: () => undefined,
      log: () => undefined,
    });
    controller.start();
    assert.equal(created, false);
    controller.close();
  });
});
