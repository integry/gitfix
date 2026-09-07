import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  DesktopNotificationCapability,
  DesktopNotificationPreferences,
  DesktopNotificationScope,
  DesktopNotificationSettings,
  DesktopPlatform,
  DesktopTaskTransition,
} from './shared/contract';

export const DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES: DesktopNotificationPreferences = Object.freeze({
  enabled: false,
  taskStarted: false,
  taskCompleted: false,
  taskFailed: true,
  taskNeedsAttention: true,
});

type NotificationKind = 'started' | 'completed' | 'failed' | 'needs-attention';

interface StoredPreferences {
  version: 1;
  accounts: Record<string, DesktopNotificationPreferences>;
}

export interface NativeNotificationHandle {
  close(): void;
  onClose?(listener: () => void): void;
}

export interface NativeNotificationPayload {
  title: string;
  body: string;
}

interface PendingNotice {
  scope: DesktopNotificationScope;
  kind: NotificationKind;
  taskId: string;
  repository?: string;
  issueNumber?: number;
}

export interface NativeNotificationServiceOptions {
  statePath: string;
  platform: DesktopPlatform;
  isSupported(): boolean;
  isActiveScope(scope: DesktopNotificationScope): boolean;
  show(payload: NativeNotificationPayload, onClick: () => void): NativeNotificationHandle;
  navigate(path: string): void;
  now?: () => number;
  batchDelayMs?: number;
  log?(level: 'warn' | 'error', event: string): void;
}

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TRANSPORT_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SAFE_USER_PATTERN = /^[^\x00-\x20\x7f]{1,128}$/;
const SAFE_TASK_PATTERN = /^[^\x00-\x1f\x7f]{1,512}$/;
const SAFE_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PROCESSING_STATES = new Set(['processing', 'claude_execution', 'post_processing']);
const ATTENTION_STATES = new Set(['action_required', 'action-required', 'needs_attention', 'needs-attention']);
const TERMINAL_KINDS = new Set<NotificationKind>(['completed', 'failed']);
const MAX_EVENT_AGE_MS = 2 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_REMEMBERED_EVENTS = 2_048;
const MAX_STORED_ACCOUNTS = 1_000;
const MAX_INDIVIDUAL_BURST = 3;
const DELIVERY_RATE_WINDOW_MS = 30_000;
const MAX_DELIVERIES_PER_WINDOW = 6;

const copyDefaults = (): DesktopNotificationPreferences => ({
  ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
});

export const isDesktopNotificationScope = (value: unknown): value is DesktopNotificationScope => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return Object.keys(scope).every(key => ['profileId', 'transportScope', 'userId'].includes(key))
    && typeof scope.profileId === 'string' && PROFILE_PATTERN.test(scope.profileId)
    && typeof scope.transportScope === 'string' && TRANSPORT_PATTERN.test(scope.transportScope)
    && typeof scope.userId === 'string' && SAFE_USER_PATTERN.test(scope.userId);
};

export const isDesktopTaskTransition = (value: unknown): value is DesktopTaskTransition => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (!Object.keys(event).every(key => [
    'taskId', 'state', 'previousState', 'repository', 'issueNumber', 'timestamp', 'version',
  ].includes(key))) return false;
  if (typeof event.taskId !== 'string' || !SAFE_TASK_PATTERN.test(event.taskId)
    || typeof event.state !== 'string' || event.state.length < 1 || event.state.length > 64
    || typeof event.previousState !== 'string' || event.previousState.length < 1
    || event.previousState.length > 64
    || typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp))) return false;
  if (event.repository !== undefined && (
    typeof event.repository !== 'string' || event.repository.length > 256
    || !SAFE_REPOSITORY_PATTERN.test(event.repository)
  )) return false;
  if (event.issueNumber !== undefined && (
    !Number.isSafeInteger(event.issueNumber) || (event.issueNumber as number) < 1
  )) return false;
  return event.version === undefined || (
    Number.isSafeInteger(event.version) && (event.version as number) >= 0
  );
};

const transitionKind = (event: DesktopTaskTransition): NotificationKind | null => {
  if (event.state === event.previousState) return null;
  if (event.state === 'completed') return 'completed';
  if (event.state === 'failed') return 'failed';
  if (ATTENTION_STATES.has(event.state)) return 'needs-attention';
  if (PROCESSING_STATES.has(event.state) && !PROCESSING_STATES.has(event.previousState)) return 'started';
  return null;
};

const preferenceForKind = (
  preferences: DesktopNotificationPreferences,
  kind: NotificationKind,
): boolean => kind === 'started' ? preferences.taskStarted
  : kind === 'completed' ? preferences.taskCompleted
    : kind === 'failed' ? preferences.taskFailed
      : preferences.taskNeedsAttention;

const isPreferences = (value: unknown): value is DesktopNotificationPreferences => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES).every(
    key => typeof record[key] === 'boolean',
  ) && Object.keys(record).every(key => key in DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES);
};

const safeStoredPreferences = (value: unknown): StoredPreferences | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || !state.accounts || typeof state.accounts !== 'object'
    || Array.isArray(state.accounts)) return null;
  const accounts = state.accounts as Record<string, unknown>;
  if (Object.keys(accounts).length > MAX_STORED_ACCOUNTS
    || !Object.values(accounts).every(isPreferences)) return null;
  return { version: 1, accounts: accounts as Record<string, DesktopNotificationPreferences> };
};

const scopeStorageKey = (scope: DesktopNotificationScope): string => createHash('sha256')
  .update(`${scope.profileId}\0${scope.userId}`)
  .digest('base64url');

const sameScope = (left: DesktopNotificationScope, right: DesktopNotificationScope): boolean =>
  left.profileId === right.profileId
  && left.transportScope === right.transportScope
  && left.userId === right.userId;

const taskContext = (notice: PendingNotice): string => {
  const task = notice.issueNumber ? `Task #${notice.issueNumber}` : 'Task';
  return notice.repository ? `${notice.repository} · ${task}` : task;
};

const kindTitle = (kind: NotificationKind): string => kind === 'started' ? 'Task started'
  : kind === 'completed' ? 'Task completed'
    : kind === 'failed' ? 'Task failed'
      : 'Task needs attention';

const groupedBody = (notices: PendingNotice[]): string => {
  const counts = new Map<NotificationKind, number>();
  notices.forEach(notice => counts.set(notice.kind, (counts.get(notice.kind) ?? 0) + 1));
  return ([
    ['failed', 'failed'],
    ['needs-attention', 'need attention'],
    ['completed', 'completed'],
    ['started', 'started'],
  ] as const).flatMap(([kind, label]) => {
    const count = counts.get(kind);
    return count ? [`${count} ${label}`] : [];
  }).join(' · ');
};

export class NativeNotificationService {
  readonly #options: NativeNotificationServiceOptions;
  readonly #now: () => number;
  readonly #batchDelayMs: number;
  #state: StoredPreferences = { version: 1, accounts: {} };
  #loaded: Promise<void> | null = null;
  #writeTail: Promise<void> = Promise.resolve();
  #pending: PendingNotice[] = [];
  #batchTimer: ReturnType<typeof setTimeout> | null = null;
  #seen = new Map<string, true>();
  #terminal = new Map<string, true>();
  #live = new Set<NativeNotificationHandle>();
  #accountScope: DesktopNotificationScope | null = null;
  #deliveryTimes: number[] = [];
  #closed = false;

  constructor(options: NativeNotificationServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#batchDelayMs = options.batchDelayMs ?? 750;
  }

  capability(): DesktopNotificationCapability {
    if (this.#options.platform === 'win32') {
      return { supported: false, platform: 'win32', permission: 'unsupported', reason: 'platform-deferred' };
    }
    const supported = (this.#options.platform === 'linux' || this.#options.platform === 'darwin')
      && this.#options.isSupported();
    return supported
      ? { supported: true, platform: this.#options.platform, permission: 'unknown' }
      : { supported: false, platform: this.#options.platform, permission: 'unsupported', reason: 'native-api-unavailable' };
  }

  async get(scope: DesktopNotificationScope): Promise<DesktopNotificationSettings> {
    this.#requireActiveScope(scope);
    this.#activateScope(scope);
    await this.#load();
    return this.#settings(scope);
  }

  async update(
    scope: DesktopNotificationScope,
    update: Partial<DesktopNotificationPreferences>,
  ): Promise<DesktopNotificationSettings> {
    this.#requireActiveScope(scope);
    if (!update || typeof update !== 'object' || Array.isArray(update)
      || Object.keys(update).length === 0
      || !Object.keys(update).every(key => key in DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES)
      || !Object.values(update).every(value => typeof value === 'boolean')) {
      throw new Error('Invalid desktop notification preferences');
    }
    this.#activateScope(scope);
    await this.#load();
    const key = scopeStorageKey(scope);
    if (update.enabled === false) this.#clearDeliveries(scope);
    return this.#queueUpdate(scope, key, update);
  }

  async test(scope: DesktopNotificationScope): Promise<{ invoked: boolean }> {
    this.#requireActiveScope(scope);
    this.#activateScope(scope);
    await this.#load();
    const settings = this.#settings(scope);
    if (!settings.capability.supported || !settings.preferences.enabled) return { invoked: false };
    this.#display(scope, {
      title: 'Desktop notifications are ready',
      body: 'ProPR can send task status updates on this device.',
    }, '/tasks');
    return { invoked: true };
  }

  async publish(
    scope: DesktopNotificationScope,
    transition: DesktopTaskTransition,
  ): Promise<{ accepted: boolean }> {
    if (this.#closed || !isDesktopNotificationScope(scope) || !isDesktopTaskTransition(transition)
      || !this.#isCurrentScope(scope)) return { accepted: false };
    const kind = transitionKind(transition);
    if (!kind) return { accepted: false };
    const occurredAt = Date.parse(transition.timestamp);
    const now = this.#now();
    if (occurredAt < now - MAX_EVENT_AGE_MS || occurredAt > now + MAX_FUTURE_SKEW_MS) {
      return { accepted: false };
    }
    await this.#load();
    const preferences = this.#state.accounts[scopeStorageKey(scope)] ?? copyDefaults();
    if (!preferences.enabled || !this.capability().supported || !preferenceForKind(preferences, kind)) {
      return { accepted: false };
    }
    const scopeKey = scopeStorageKey(scope);
    const eventKey = `${scopeKey}:${transition.taskId}:${kind}:${transition.version ?? transition.timestamp}`;
    const terminalKey = `${scopeKey}:${transition.taskId}:${kind}`;
    if (this.#seen.has(eventKey) || (TERMINAL_KINDS.has(kind) && this.#terminal.has(terminalKey))) {
      return { accepted: false };
    }
    this.#remember(this.#seen, eventKey);
    if (TERMINAL_KINDS.has(kind)) this.#remember(this.#terminal, terminalKey);
    this.#pending.push({
      scope: { ...scope }, kind, taskId: transition.taskId,
      repository: transition.repository, issueNumber: transition.issueNumber,
    });
    this.#batchTimer ??= setTimeout(() => this.#flush(), this.#batchDelayMs);
    return { accepted: true };
  }

  clear(scope?: DesktopNotificationScope): void {
    this.#clearDeliveries(scope);
    if (!scope || (this.#accountScope && sameScope(this.#accountScope, scope))) this.#accountScope = null;
  }

  #clearDeliveries(scope?: DesktopNotificationScope): void {
    const matches = (notice: PendingNotice): boolean => !scope || sameScope(notice.scope, scope);
    this.#pending = this.#pending.filter(notice => !matches(notice));
    if (this.#pending.length === 0 && this.#batchTimer) {
      clearTimeout(this.#batchTimer);
      this.#batchTimer = null;
    }
    for (const notification of this.#live) notification.close();
    this.#live.clear();
  }

  close(): void {
    this.#closed = true;
    this.clear();
    this.#seen.clear();
    this.#terminal.clear();
    this.#deliveryTimes = [];
  }

  async idle(): Promise<void> {
    await this.#writeTail;
  }

  #requireActiveScope(scope: DesktopNotificationScope): void {
    if (!isDesktopNotificationScope(scope) || !this.#options.isActiveScope(scope)) {
      throw new Error('Stale desktop notification scope');
    }
  }

  #activateScope(scope: DesktopNotificationScope): void {
    if (this.#accountScope && !sameScope(this.#accountScope, scope)) {
      this.#clearDeliveries();
      this.#seen.clear();
      this.#terminal.clear();
    }
    this.#accountScope = { ...scope };
  }

  #isCurrentScope(scope: DesktopNotificationScope): boolean {
    return Boolean(this.#accountScope && sameScope(this.#accountScope, scope)
      && this.#options.isActiveScope(scope));
  }

  #settings(scope: DesktopNotificationScope): DesktopNotificationSettings {
    return {
      preferences: { ...(this.#state.accounts[scopeStorageKey(scope)] ?? copyDefaults()) },
      capability: this.capability(),
      scope: 'account-instance-device',
    };
  }

  #remember(map: Map<string, true>, key: string): void {
    map.set(key, true);
    if (map.size > MAX_REMEMBERED_EVENTS) {
      const oldest = map.keys().next().value;
      if (oldest) map.delete(oldest);
    }
  }

  #flush(): void {
    this.#batchTimer = null;
    const pending = this.#pending.splice(0);
    const active = pending.filter(notice => {
      if (!this.#isCurrentScope(notice.scope)) return false;
      const preferences = this.#state.accounts[scopeStorageKey(notice.scope)] ?? copyDefaults();
      return preferences.enabled && preferenceForKind(preferences, notice.kind);
    });
    const groups = new Map<string, PendingNotice[]>();
    active.forEach(notice => {
      const key = `${notice.scope.profileId}\0${notice.scope.transportScope}\0${notice.scope.userId}`;
      groups.set(key, [...(groups.get(key) ?? []), notice]);
    });
    for (const notices of groups.values()) {
      const scope = notices[0].scope;
      const available = this.#availableDeliveries();
      if (available === 0) continue;
      if (notices.length > MAX_INDIVIDUAL_BURST || notices.length > available) {
        this.#display(scope, {
          title: `${notices.length} task updates`,
          body: groupedBody(notices),
        }, '/tasks');
        continue;
      }
      for (const notice of notices) {
        this.#display(scope, { title: kindTitle(notice.kind), body: taskContext(notice) },
          `/tasks/${encodeURIComponent(notice.taskId)}`);
      }
    }
  }

  #display(scope: DesktopNotificationScope, payload: NativeNotificationPayload, path: string): void {
    if (this.#closed || !this.#isCurrentScope(scope) || this.#availableDeliveries() === 0) return;
    this.#deliveryTimes.push(this.#now());
    let handle: NativeNotificationHandle;
    handle = this.#options.show(payload, () => {
      this.#live.delete(handle);
      if (!this.#closed && this.#isCurrentScope(scope)) this.#options.navigate(path);
    });
    this.#live.add(handle);
    handle.onClose?.(() => this.#live.delete(handle));
  }

  #availableDeliveries(): number {
    const cutoff = this.#now() - DELIVERY_RATE_WINDOW_MS;
    this.#deliveryTimes = this.#deliveryTimes.filter(timestamp => timestamp > cutoff);
    return Math.max(0, MAX_DELIVERIES_PER_WINDOW - this.#deliveryTimes.length);
  }

  #load(): Promise<void> {
    if (this.#loaded) return this.#loaded;
    this.#loaded = readFile(this.#options.statePath, 'utf8').then(contents => {
      const parsed = safeStoredPreferences(JSON.parse(contents));
      if (parsed) this.#state = parsed;
      else this.#options.log?.('warn', 'desktop.notifications.preferences_invalid');
    }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#options.log?.('warn', 'desktop.notifications.preferences_load_failed');
      }
    });
    return this.#loaded;
  }

  #queueUpdate(
    scope: DesktopNotificationScope,
    key: string,
    update: Partial<DesktopNotificationPreferences>,
  ): Promise<DesktopNotificationSettings> {
    const operation = this.#writeTail.then(async () => {
      const current = this.#state.accounts[key];
      if (!current && Object.keys(this.#state.accounts).length >= MAX_STORED_ACCOUNTS) {
        throw new Error('Desktop notification preference account limit reached');
      }
      const nextState: StoredPreferences = {
        version: 1,
        accounts: {
          ...this.#state.accounts,
          [key]: { ...(current ?? copyDefaults()), ...update },
        },
      };
      await this.#persist(nextState);
      this.#state = nextState;
      return this.#settings(scope);
    });
    this.#writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #persist(state: StoredPreferences): Promise<void> {
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    const temporary = `${this.#options.statePath}.tmp`;
    try {
      await mkdir(dirname(this.#options.statePath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#options.statePath);
    } catch {
      this.#options.log?.('error', 'desktop.notifications.preferences_save_failed');
      throw new Error('Desktop notification preferences could not be saved');
    }
  }
}
