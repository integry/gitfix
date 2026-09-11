import { HashRouter, Link } from 'react-router-dom';
import { DesktopNativeNavigationObserver } from './DesktopNativeNavigationObserver';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplicationMenuTemplate } from '../../../apps/desktop/src/application-menu';
import { createDesktopNativeCommandDispatcher } from '../../../apps/desktop/src/native-commands';
import { createDesktopBridge } from '../../../apps/desktop/src/preload-bridge';
import { IPC_CHANNELS, isDesktopNativeNavigationState } from '../../../apps/desktop/src/shared/contract';
import type { DesktopConnectionScope } from '../../../apps/desktop/src/shared/contract';
import type { ExperienceState } from './desktopExperienceState';
import { useDesktopNativeCommands } from './useDesktopNativeCommands';

const scopeA = { profileId: 'account-a', transportScope: 'abcdefghijklmnopqrstuv' };
const scopeB = { profileId: 'account-a', transportScope: 'zyxwvutsrqponmlkjihgfe' };
const connected = (scope: DesktopConnectionScope): ExperienceState => ({
  phase: 'connected',
  profile: { id: scope.profileId, name: 'Test instance', kind: 'remote', baseUrl: 'https://instance.example' },
  result: { status: 'ready', version: '0.8.15', ...scope },
});

const fixture = () => {
  let scope: DesktopConnectionScope | null = scopeA;
  const listeners = new Map<string, (event: unknown, value: unknown) => void>();
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, value: unknown) => listeners.get(channel)?.({}, value) },
  };
  const restore = vi.fn();
  const dispatcher = createDesktopNativeCommandDispatcher({
    channel: IPC_CHANNELS.nativeCommand,
    // A different/focused window must not receive commands for this renderer.
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: () => { throw new Error('Wrong window'); } } }),
    restoreWindow: restore,
    activeConnectionScope: () => scope,
    activeNotificationScope: () => null,
    notificationState: () => ({ available: false, enabled: false }),
    setNativeNotificationsEnabled: async () => undefined,
    quit: () => undefined,
  });
  const bridge = createDesktopBridge({
    on: (channel, listener) => { listeners.set(channel, listener); },
    removeListener: channel => { listeners.delete(channel); },
    invoke: async (channel, state) => {
      if (channel === IPC_CHANNELS.nativeNavigationState && isDesktopNativeNavigationState(state)) {
        dispatcher.updateNavigationState?.(state);
      }
    },
  });
  dispatcher.rendererReady(mainWindow);
  dispatcher.connectionAvailable();
  const onManageInstances = vi.fn();
  const onChooseInstances = vi.fn();
  const onNavigate = vi.fn();
  const hook = renderHook(({ state, blocked }: { state: ExperienceState; blocked: boolean }) => useDesktopNativeCommands({
    app: bridge.app, state, instanceChooserBlocked: blocked, onManageInstances, onChooseInstances,
    onNavigate, onReconnect: async () => undefined,
  }), { initialProps: { state: connected(scopeA), blocked: false } });
  const item = (label: string) => createApplicationMenuTemplate('darwin', dispatcher)
    .flatMap(item => Array.isArray(item.submenu) ? item.submenu : []).find(item => item.label === label)!;
  const click = async (label: string) => {
    await act(async () => { (item(label).click as () => void)(); });
    await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
  };
  return { ...hook, item, click, restore, dispatcher, onManageInstances, onChooseInstances, onNavigate,
    switchTo(next: DesktopConnectionScope) {
      dispatcher.connectionUnavailable();
      scope = next;
      dispatcher.connectionAvailable();
      hook.rerender({ state: connected(next), blocked: false });
    },
  };
};

describe('macOS menu to dispatcher to preload to renderer navigation', () => {
  beforeEach(() => {
    vi.stubGlobal('__PROPR_DESKTOP__', true);
    window.location.hash = '#/';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('routes every section and creation shortcut to the real desktop URL', async () => {
    const value = fixture();
    for (const [label, path, shortcut] of [
      ['Dashboard', '/', '1'], ['Inbox', '/inbox', '2'], ['Plans', '/plans', '3'],
      ['Goals', '/goals', '4'], ['Tasks', '/tasks', '5'], ['Repositories', '/repositories', '6'],
      ['LLM Log', '/llm-logs', '7'], ['Settings…', '/settings', ','], ['New Plan', '/studio/new', 'N'],
    ]) {
      expect(value.item(label).accelerator).toBe(`CmdOrCtrl+${shortcut}`);
      await value.click(label);
      expect(window.location.hash).toBe(`#${path}`);
    }
    expect(value.restore).toHaveBeenCalledTimes(9);
    expect(value.onNavigate).toHaveBeenCalledTimes(9);
    await value.click('Switch / Manage Instances…');
    expect(value.onManageInstances).toHaveBeenCalledOnce();
  });

  it('uses current-account history, retains filters, and drops the forward branch after new navigation', async () => {
    const value = fixture();
    expect(value.item('Back').enabled).toBe(false);
    await value.click('Tasks');
    await act(async () => { window.location.hash = '#/tasks?status=completed'; });
    await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await value.click('Settings…');
    expect(value.item('Back').enabled).toBe(true);
    await value.click('Back');
    expect(window.location.hash).toBe('#/tasks?status=completed');
    expect(value.item('Forward').enabled).toBe(true);
    await value.click('Forward');
    expect(window.location.hash).toBe('#/settings');
    await value.click('Back');
    await value.click('Goals');
    expect(value.item('Forward').enabled).toBe(false);
    act(() => value.switchTo(scopeB));
    expect(value.item('Back').enabled).toBe(false);
    expect(value.item('Forward').enabled).toBe(false);
    act(() => value.dispatcher.updateNavigationState?.({ connectionScope: scopeA, canManageInstances: true, canGoBack: true, canGoForward: true }));
    expect(value.item('Back').enabled).toBe(false);
    await value.click('Back');
    expect(window.location.hash).toBe('#/goals');
  });

  it('records actual HashRouter links as well as native commands', async () => {
    const value = fixture();
    render(<HashRouter><DesktopNativeNavigationObserver /><Link to="/tasks/task-42?tab=output">Task details</Link></HashRouter>);
    fireEvent.click(screen.getByRole('link', { name: 'Task details' }));
    expect(window.location.hash).toBe('#/tasks/task-42?tab=output');
    expect(value.item('Back').enabled).toBe(true);
    await value.click('Settings…');
    await value.click('Back');
    expect(window.location.hash).toBe('#/tasks/task-42?tab=output');
    await value.click('Back');
    expect(window.location.hash).toBe('#/');
  });

  it('guards unsaved plans for both section and history navigation', async () => {
    const value = fixture();
    await value.click('New Plan');
    vi.mocked(window.confirm).mockReturnValue(false);
    await value.click('Back');
    expect(window.location.hash).toBe('#/studio/new');
    await value.click('Settings…');
    expect(window.location.hash).toBe('#/studio/new');
    expect(value.item('Forward').enabled).toBe(false);
    vi.mocked(window.confirm).mockReturnValue(true);
    await value.click('Back');
    expect(window.location.hash).toBe('#/');
  });

  it('disables navigation and busy instance actions during setup, offline and logged-out transitions', async () => {
    const value = fixture();
    await value.click('Tasks');
    act(() => value.dispatcher.connectionUnavailable());
    value.rerender({ state: { phase: 'choose' }, blocked: true });
    for (const label of ['Settings…', 'Tasks', 'New Plan', 'Back', 'Forward', 'Switch / Manage Instances…']) {
      expect(value.item(label).enabled).toBe(false);
      await value.click(label);
    }
    expect(window.location.hash).toBe('#/tasks');
    expect(value.onChooseInstances).not.toHaveBeenCalled();
    value.rerender({ state: { phase: 'choose' }, blocked: false });
    expect(value.item('Switch / Manage Instances…').enabled).toBe(true);
    await value.click('Switch / Manage Instances…');
    expect(value.onChooseInstances).toHaveBeenCalledOnce();
  });
});
