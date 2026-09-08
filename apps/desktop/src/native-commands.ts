import type {
  DesktopConnectionScope,
  DesktopNativeCommand,
  DesktopNativeCommandDelivery,
  DesktopNotificationScope,
} from './shared/contract';

export type DesktopMainCommand = DesktopNativeCommand | 'open' | 'toggle-native-notifications';

export interface DesktopNativeCommandState {
  authenticated: boolean;
  nativeNotificationsAvailable: boolean;
  nativeNotificationsEnabled: boolean;
}

interface CommandWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, value: DesktopNativeCommandDelivery): void };
}

interface DesktopNativeCommandDispatcherOptions {
  channel: string;
  getWindow(): CommandWindow | null;
  restoreWindow(): void;
  activeConnectionScope(): DesktopConnectionScope | null;
  activeNotificationScope(): DesktopNotificationScope | null;
  notificationState(): { available: boolean; enabled: boolean };
  setNativeNotificationsEnabled(scope: DesktopNotificationScope, enabled: boolean): Promise<void>;
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

const sameConnectionScope = (
  left: DesktopConnectionScope | null,
  right: DesktopConnectionScope | null,
): boolean => left === null || right === null
  ? left === right
  : left.profileId === right.profileId && left.transportScope === right.transportScope;

const sameNotificationScope = (
  left: DesktopNotificationScope | null,
  right: DesktopNotificationScope | null,
): boolean => sameConnectionScope(left, right)
  && (left === null || right === null || left.userId === right.userId);

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
  let pending: DesktopNativeCommandDelivery | null = null;
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

  const deliver = (command: DesktopNativeCommand, connectionScope: DesktopConnectionScope | null): void => {
    const window = readyWindow && !readyWindow.isDestroyed() ? readyWindow : options.getWindow();
    if (!ready || !window || window.isDestroyed()) {
      pending = { command, connectionScope };
      return;
    }
    if (AUTHENTICATED_COMMANDS.has(command)
      && (!state().authenticated
        || !sameConnectionScope(connectionScope, options.activeConnectionScope()))) return;
    window.webContents.send(options.channel, {
      command,
      connectionScope: connectionScope ? { ...connectionScope } : null,
    });
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
        const notificationScope = options.activeNotificationScope();
        if (!notificationScope) return;
        const generation = connectionGeneration;
        notificationToggleTail = notificationToggleTail.then(async () => {
          if (closed || generation !== connectionGeneration
            || !sameNotificationScope(notificationScope, options.activeNotificationScope())) return;
          const latest = state();
          if (!latest.nativeNotificationsAvailable) return;
          await options.setNativeNotificationsEnabled(
            notificationScope,
            !latest.nativeNotificationsEnabled,
          );
        })
          .catch(() => options.log?.('warn', 'desktop.native_command.notifications_update_failed'))
          .finally(() => { if (!closed) notify(); });
        return;
      }

      const activeConnection = options.activeConnectionScope();
      const connection = activeConnection ? { ...activeConnection } : null;
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
      if (queued) deliver(queued.command, queued.connectionScope);
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
