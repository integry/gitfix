import type { DesktopConnectionScope, DesktopNativeCommand } from './shared/contract';

export type DesktopMainCommand = DesktopNativeCommand | 'open' | 'toggle-native-notifications';

export interface DesktopNativeCommandState {
  authenticated: boolean;
  nativeNotificationsAvailable: boolean;
  nativeNotificationsEnabled: boolean;
}

interface CommandWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, value: DesktopNativeCommand): void };
}

interface DesktopNativeCommandDispatcherOptions {
  channel: string;
  getWindow(): CommandWindow | null;
  restoreWindow(): void;
  activeConnectionScope(): DesktopConnectionScope | null;
  notificationState(): { available: boolean; enabled: boolean };
  setNativeNotificationsEnabled(enabled: boolean): Promise<void>;
  quit(): void;
  log?(level: 'warn', event: string): void;
}

export interface DesktopNativeCommandDispatcher {
  dispatch(command: DesktopMainCommand): void;
  getState(): DesktopNativeCommandState;
  rendererReady(window?: CommandWindow): void;
  rendererUnavailable(): void;
  connectionAvailable(): void;
  connectionUnavailable(): void;
  refresh(): void;
  subscribe(listener: () => void): () => void;
  close(): void;
}

const AUTHENTICATED_COMMANDS = new Set<DesktopNativeCommand>([
  'new-plan', 'tasks', 'plans', 'inbox', 'notification-settings',
]);

const scopeKey = (scope: DesktopConnectionScope | null): string | null =>
  scope ? `${scope.profileId}\0${scope.transportScope}` : null;

/**
 * The single native action boundary. It accepts only a closed command union,
 * binds queued navigation to the active connection, and never evaluates a URL
 * or renderer-provided command.
 */
export const createDesktopNativeCommandDispatcher = (
  options: DesktopNativeCommandDispatcherOptions,
): DesktopNativeCommandDispatcher => {
  const listeners = new Set<() => void>();
  let ready = false;
  let closed = false;
  let connectionAvailable = false;
  let readyWindow: CommandWindow | null = null;
  let pending: { command: DesktopNativeCommand; connection: string | null } | null = null;
  let notificationToggleTail: Promise<void> = Promise.resolve();
  let connectionGeneration = 0;

  const state = (): DesktopNativeCommandState => {
    const authenticated = connectionAvailable && options.activeConnectionScope() !== null;
    const notifications = options.notificationState();
    return {
      authenticated,
      nativeNotificationsAvailable: authenticated && notifications.available,
      nativeNotificationsEnabled: authenticated && notifications.available && notifications.enabled,
    };
  };

  const notify = (): void => listeners.forEach(listener => listener());

  const deliver = (command: DesktopNativeCommand, connection: string | null): void => {
    const window = readyWindow && !readyWindow.isDestroyed() ? readyWindow : options.getWindow();
    if (!ready || !window || window.isDestroyed()) {
      pending = { command, connection };
      return;
    }
    if (AUTHENTICATED_COMMANDS.has(command)
      && (!state().authenticated || connection !== scopeKey(options.activeConnectionScope()))) return;
    window.webContents.send(options.channel, command);
  };

  return {
    dispatch(command) {
      if (closed) return;
      if (command === 'open') {
        options.restoreWindow();
        return;
      }
      if (command === 'toggle-native-notifications') {
        const current = state();
        if (!current.nativeNotificationsAvailable) return;
        const connection = scopeKey(options.activeConnectionScope());
        const generation = connectionGeneration;
        notificationToggleTail = notificationToggleTail.then(async () => {
          if (closed || generation !== connectionGeneration
            || connection !== scopeKey(options.activeConnectionScope())) return;
          const latest = state();
          if (!latest.nativeNotificationsAvailable) return;
          await options.setNativeNotificationsEnabled(!latest.nativeNotificationsEnabled);
        })
          .catch(() => options.log?.('warn', 'desktop.native_command.notifications_update_failed'))
          .finally(() => { if (!closed) notify(); });
        return;
      }

      const connection = scopeKey(options.activeConnectionScope());
      if (AUTHENTICATED_COMMANDS.has(command) && !state().authenticated) return;
      options.restoreWindow();
      deliver(command, connection);
    },
    getState: state,
    rendererReady(window) {
      if (closed) return;
      ready = true;
      readyWindow = window ?? options.getWindow();
      const queued = pending;
      pending = null;
      if (queued) deliver(queued.command, queued.connection);
    },
    rendererUnavailable() {
      ready = false;
      readyWindow = null;
    },
    connectionAvailable() {
      if (closed) return;
      connectionAvailable = true;
      notify();
    },
    connectionUnavailable() {
      connectionAvailable = false;
      connectionGeneration += 1;
      if (pending && AUTHENTICATED_COMMANDS.has(pending.command)) pending = null;
      notify();
    },
    refresh: notify,
    subscribe(listener) {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      connectionGeneration += 1;
      ready = false;
      readyWindow = null;
      pending = null;
      listeners.clear();
    },
  };
};
