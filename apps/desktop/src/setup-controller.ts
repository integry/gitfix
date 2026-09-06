import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  getLocalSetupCapability, retrySetup, runSetup,
  type GithubAuthDecision, type SetupActions, type SetupRunResult,
} from '@propr/local-setup';
import { DEFAULT_PROPR_GH_RELAY_URL } from '@propr/shared';
import { bindRootOperations, RootDirectoryAuthority, SetupFilesystemCapabilities, SetupSecretCapabilities } from './setup-capabilities';
import { parseDesktopSetupRequest, SetupRequestError } from './setup-schema';
import type {
  DesktopFilesystemSelection, DesktopSecretSelection, DesktopSetupRequest,
  DesktopSetupResumeView, DesktopSetupSnapshot,
} from './shared/contract';

interface ResolvedRequest {
  request: DesktopSetupRequest;
  authority: RootDirectoryAuthority;
  privateKeyPath?: string;
  webhookSecret?: string;
}

interface PersistedSetup {
  version: 1;
  phase: 'running' | 'cancelled' | 'failed' | 'completed';
  resume: DesktopSetupResumeView;
  profile?: DesktopSetupSnapshot['profile'];
}

export interface DesktopSetupControllerOptions {
  actions: SetupActions;
  platform?: NodeJS.Platform;
  appDataDir: string;
  defaultRootDir: string;
  statePath: string;
  selectPrivateKey(signal?: AbortSignal): Promise<string | null>;
  promptWebhookSecret(signal?: AbortSignal): Promise<string | null>;
  resolveApiBaseUrl(rootDir: string, signal?: AbortSignal): Promise<string>;
  emit(snapshot: DesktopSetupSnapshot): void;
  diagnose?(event: string, fields?: Record<string, unknown>): void;
  sessionId?: string;
}

const copyResume = (value: DesktopSetupResumeView): DesktopSetupResumeView => structuredClone(value);
const SETUP_PHASES = new Set<PersistedSetup['phase']>(['running', 'cancelled', 'failed', 'completed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validCompletedProfile = (value: unknown): value is NonNullable<DesktopSetupSnapshot['profile']> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  if (Object.keys(profile).some(key => !['id', 'name', 'baseUrl', 'kind'].includes(key))
    || typeof profile.id !== 'string' || !UUID.test(profile.id)
    || typeof profile.name !== 'string' || profile.name.length === 0 || profile.name.length > 100
    || profile.kind !== 'local' || typeof profile.baseUrl !== 'string' || profile.baseUrl.length > 2048) return false;
  try {
    const url = new URL(profile.baseUrl);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && Boolean(url.port) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
};

export class DesktopSetupController {
  readonly #options: DesktopSetupControllerOptions;
  readonly #sessionId: string;
  readonly #filesystem = new SetupFilesystemCapabilities();
  readonly #secrets = new SetupSecretCapabilities();
  #snapshot: DesktopSetupSnapshot;
  #abort: AbortController | null = null;
  #current: Promise<DesktopSetupSnapshot> | null = null;
  #result: SetupRunResult | null = null;
  #resolved: ResolvedRequest | null = null;
  #resume: DesktopSetupResumeView | null = null;
  #loaded = false;

  constructor(options: DesktopSetupControllerOptions) {
    this.#options = options;
    this.#sessionId = options.sessionId ?? randomUUID();
    const capability = getLocalSetupCapability(options.platform ?? process.platform);
    this.#snapshot = {
      phase: capability.supported ? 'idle' : 'unsupported', capability,
      sessionId: this.#sessionId, logs: [], resumeAvailable: false,
      ...(capability.supported ? {} : { error: capability.reason }),
    };
  }

  async status(): Promise<DesktopSetupSnapshot> { this.#load(); return this.#publicSnapshot(); }

  async selectPrivateKey(signal?: AbortSignal): Promise<DesktopFilesystemSelection | null> {
    this.#assertSupported(); signal?.throwIfAborted();
    const selected = await this.#options.selectPrivateKey(signal);
    return selected ? this.#filesystem.issue(this.#sessionId, selected, signal) : null;
  }

  async acquireWebhookSecret(signal?: AbortSignal): Promise<DesktopSecretSelection | null> {
    this.#assertSupported(); signal?.throwIfAborted();
    const value = await this.#options.promptWebhookSecret(signal);
    return value === null ? null : this.#secrets.issue(this.#sessionId, value);
  }

  start(input: unknown): Promise<DesktopSetupSnapshot> { return this.#begin(parseDesktopSetupRequest(input), false); }

  async retry(input?: unknown): Promise<DesktopSetupSnapshot> {
    this.#load(); this.#assertSupported();
    if (input !== undefined) return this.#begin(parseDesktopSetupRequest(input), true);
    if (this.#current) throw new SetupRequestError('Local setup is already running.');
    if (!this.#resume) throw new SetupRequestError('There is no local setup to retry.');
    if (!this.#resolved) {
      if (this.#resume.reconfigurationStage) throw new SetupRequestError(`Re-enter the ${this.#resume.reconfigurationStage} configuration before retrying.`);
      const request = parseDesktopSetupRequest({
        sessionId: this.#sessionId, root: { mode: 'resume' }, reinitialize: this.#resume.reinitialize,
        agents: this.#resume.agents, github: this.#resume.github, intake: this.#resume.intake,
        whitelist: this.#resume.whitelist, repository: this.#resume.repository,
      });
      return this.#begin(request, true);
    }
    return this.#runResolved(this.#resolved, true);
  }

  async cancel(): Promise<DesktopSetupSnapshot> {
    this.#abort?.abort();
    await this.#current?.catch(() => undefined);
    return this.#publicSnapshot();
  }

  async shutdown(): Promise<void> {
    this.#abort?.abort();
    await this.#current?.catch(() => undefined);
    this.#filesystem.clear(); this.#secrets.clear(); this.#resolved?.authority.close();
  }

  async #begin(request: DesktopSetupRequest, retry: boolean): Promise<DesktopSetupSnapshot> {
    this.#load(); this.#assertSupported();
    if (this.#current) throw new SetupRequestError('Local setup is already running.');
    if (request.sessionId !== this.#sessionId) throw new SetupRequestError('The setup session expired. Start again.');
    const authority = RootDirectoryAuthority.open(this.#options.defaultRootDir, this.#options.appDataDir);
    return this.#admit(signal => this.#resolveAndRun(request, authority, retry, signal));
  }

  async #resolveAndRun(request: DesktopSetupRequest, authority: RootDirectoryAuthority, retry: boolean, signal: AbortSignal): Promise<DesktopSetupSnapshot> {
    try {
      const privateKeyPath = request.github.mode === 'app'
        ? await this.#filesystem.consume(request.github.privateKeyCapability, this.#sessionId, `${this.#options.statePath}.keys`, signal)
        : undefined;
      signal.throwIfAborted();
      const webhookSecret = request.intake.mode === 'direct_webhook'
        ? this.#secrets.consume(request.intake.secretCapability, this.#sessionId, signal) : undefined;
      const resolved = { request, authority, privateKeyPath, webhookSecret };
      if (this.#resolved?.authority !== authority) this.#resolved?.authority.close();
      this.#resolved = resolved;
      this.#resume = this.#resumeFrom(request);
      return await this.#executeResolved(resolved, retry, signal);
    } catch (error) {
      if (this.#resolved?.authority !== authority) authority.close();
      if (signal.aborted || (error as Error).name === 'AbortError') {
        this.#resume = this.#resumeFrom(request);
        this.#snapshot = {
          phase: 'cancelled', capability: getLocalSetupCapability(this.#options.platform ?? process.platform),
          sessionId: this.#sessionId, logs: [], resume: copyResume(this.#resume), resumeAvailable: true,
          reconfigurationRequired: Boolean(this.#resume.reconfigurationStage), error: 'Setup was cancelled safely.',
        };
        this.#publish();
        return this.#publicSnapshot();
      }
      throw error;
    }
  }

  #runResolved(resolved: ResolvedRequest, retry: boolean): Promise<DesktopSetupSnapshot> {
    if (this.#current) throw new SetupRequestError('Local setup is already running.');
    return this.#admit(signal => this.#executeResolved(resolved, retry, signal));
  }

  #admit(run: (signal: AbortSignal) => Promise<DesktopSetupSnapshot>): Promise<DesktopSetupSnapshot> {
    const controller = new AbortController();
    this.#abort = controller;
    const operation = Promise.resolve().then(() => run(controller.signal));
    this.#current = operation;
    const cleanup = () => { if (this.#current === operation) { this.#current = null; this.#abort = null; } };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  #executeResolved(resolved: ResolvedRequest, retry: boolean, signal: AbortSignal): Promise<DesktopSetupSnapshot> {
    const reconfigurationRequired = Boolean(this.#resume?.reconfigurationStage);
    this.#snapshot = {
      phase: 'running', capability: getLocalSetupCapability(this.#options.platform ?? process.platform),
      sessionId: this.#sessionId, logs: retry ? ['Retrying setup with a fresh host inspection…'] : [],
      resume: copyResume(this.#resume!), resumeAvailable: true, reconfigurationRequired,
    };
    this.#publish();
    return this.#execute(resolved, retry, signal);
  }

  async #execute(resolved: ResolvedRequest, retry: boolean, signal: AbortSignal): Promise<DesktopSetupSnapshot> {
    const reporter = {
      onState: (state: SetupRunResult['state']) => { this.#snapshot = { ...this.#snapshot, state }; this.#publish(); },
      onLog: (line: string) => { this.#snapshot = { ...this.#snapshot, logs: [...this.#snapshot.logs, line].slice(-200) }; this.#publish(); },
    };
    try {
      const actions = bindRootOperations(this.#options.actions, resolved.authority);
      const options = { actions, prompts: this.#prompts(resolved), reporter, platform: this.#options.platform ?? process.platform, signal };
      const result = retry && this.#result ? await retrySetup(this.#result, options) : await runSetup({ ...options, root: this.#options.defaultRootDir });
      this.#result = result;
      signal.throwIfAborted();
      let profile: DesktopSetupSnapshot['profile'];
      if (result.completed) {
        resolved.authority.validate();
        const baseUrl = await this.#options.resolveApiBaseUrl(this.#options.defaultRootDir, signal);
        signal.throwIfAborted(); resolved.authority.validate();
        profile = { id: randomUUID(), name: 'This computer', baseUrl, kind: 'local' };
      }
      this.#snapshot = {
        ...this.#snapshot, phase: result.completed ? 'completed' : result.cancelled ? 'cancelled' : 'failed',
        state: result.state, errors: result.errors, profile,
        reconfigurationRequired: !result.completed && Boolean(this.#resume?.reconfigurationStage),
      };
    } catch (error) {
      const cancelled = signal.aborted || (error as Error).name === 'AbortError';
      if (!cancelled) this.#options.diagnose?.('desktop.setup.run_failed', { name: (error as Error).name });
      this.#snapshot = { ...this.#snapshot, phase: cancelled ? 'cancelled' : 'failed',
        reconfigurationRequired: Boolean(this.#resume?.reconfigurationStage), error: cancelled
          ? 'Setup was cancelled safely.' : 'Local setup failed unexpectedly. Review the protected desktop log for details.' };
    }
    this.#publish();
    return this.#publicSnapshot();
  }

  #prompts(resolved: ResolvedRequest) {
    const request = resolved.request;
    return {
      resolveStackRoot: async () => ({ rootDir: this.#options.defaultRootDir, reinitialize: request.reinitialize }),
      selectAgents: async () => [...request.agents],
      configureGithubAuth: async (): Promise<GithubAuthDecision> => {
        if (request.github.mode === 'keep') return { keep: true };
        if (request.github.mode === 'demo') return { mode: 'demo', vars: { PROPR_DEMO_MODE: 'true' } };
        if (request.github.mode === 'relay') return { mode: 'relay', enrollRelay: { relayUrl: DEFAULT_PROPR_GH_RELAY_URL } };
        if (!resolved.privateKeyPath) throw new SetupRequestError('Select the GitHub App private key again.');
        return { mode: 'app', vars: { PROPR_DEMO_MODE: 'false', GH_AUTH_MODE: 'app', GH_APP_ID: request.github.appId,
          HOST_GH_PRIVATE_KEY: resolved.privateKeyPath, GH_INSTALLATION_ID: request.github.installationId } };
      },
      confirmGithubLogin: async () => true,
      confirmGithubAppInstall: async () => true,
      confirmGithubAppInstalled: async () => false,
      configureIntake: async () => request.intake.mode === 'keep' ? { keep: true as const }
        : request.intake.mode === 'direct_webhook' ? { mode: 'direct_webhook' as const, webhookSecret: resolved.webhookSecret }
        : { mode: request.intake.mode },
      confirmStartStack: async () => true,
      confirmAgentLogin: async ({ candidates }: { candidates: string[] }) => candidates.filter(value => request.agents.includes(value)),
      configureWhitelist: async () => request.whitelist,
      addRepository: async () => request.repository,
      launchUi: async () => false,
    };
  }

  #resumeFrom(request: DesktopSetupRequest): DesktopSetupResumeView {
    const github: DesktopSetupResumeView['github'] = request.github.mode === 'app'
      ? { mode: 'app', appId: request.github.appId, installationId: request.github.installationId, reconfigurationRequired: true }
      : structuredClone(request.github);
    const intake: DesktopSetupResumeView['intake'] = request.intake.mode === 'direct_webhook'
      ? { mode: 'direct_webhook', reconfigurationRequired: true } : structuredClone(request.intake);
    return { agents: [...request.agents], reinitialize: request.reinitialize, github, intake,
      whitelist: request.whitelist ? [...request.whitelist] : null,
      repository: request.repository ? { ...request.repository } : null,
      ...(request.github.mode === 'app' ? { reconfigurationStage: 'github' as const }
        : request.intake.mode === 'direct_webhook' ? { reconfigurationStage: 'intake' as const } : {}) };
  }

  #load(): void {
    if (this.#loaded) return; this.#loaded = true;
    try {
      const persisted = JSON.parse(readFileSync(this.#options.statePath, 'utf8')) as PersistedSetup;
      if (persisted.version !== 1 || !persisted.resume || !SETUP_PHASES.has(persisted.phase)) throw new Error('invalid');
      this.#resume = copyResume(persisted.resume);
      const completedProfile = persisted.phase === 'completed' && validCompletedProfile(persisted.profile)
        ? structuredClone(persisted.profile) : undefined;
      const restorationFailed = persisted.phase === 'completed' && !completedProfile;
      this.#snapshot = { ...this.#snapshot,
        phase: persisted.phase === 'running' || restorationFailed ? 'interrupted' : persisted.phase,
        resume: copyResume(persisted.resume), resumeAvailable: true,
        reconfigurationRequired: !completedProfile && Boolean(persisted.resume.reconfigurationStage),
        ...(completedProfile ? { profile: completedProfile } : {}),
        ...(persisted.phase === 'running' ? { error: 'Setup was interrupted. Review the saved choices to continue.' }
          : restorationFailed ? { error: 'Completed setup could not be restored. Review the saved choices to recover.' } : {}) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#options.diagnose?.('desktop.setup.hydration_failed'); }
  }

  #persist(): void {
    if (!this.#resume || this.#snapshot.phase === 'idle' || this.#snapshot.phase === 'unsupported') return;
    const value: PersistedSetup = { version: 1,
      phase: this.#snapshot.phase === 'interrupted' ? 'running' : this.#snapshot.phase,
      resume: this.#resume,
      ...(this.#snapshot.phase === 'completed' && this.#snapshot.profile ? { profile: this.#snapshot.profile } : {}),
    };
    const path = this.#options.statePath; const temp = `${path}.tmp`;
    try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 }); renameSync(temp, path); }
    catch { try { unlinkSync(temp); } catch { /* not created */ } this.#snapshot = { ...this.#snapshot, resumeAvailable: false }; }
  }

  #publish(): void { this.#persist(); this.#options.emit(this.#publicSnapshot()); }
  #assertSupported(): void {
    const capability = getLocalSetupCapability(this.#options.platform ?? process.platform);
    if (!capability.supported) throw new SetupRequestError(capability.reason);
  }
  #publicSnapshot(): DesktopSetupSnapshot {
    const root = resolve(this.#options.defaultRootDir);
    const secretValues = [this.#resolved?.privateKeyPath, this.#resolved?.webhookSecret].filter((value): value is string => Boolean(value));
    const scrub = (value: unknown): unknown => {
      if (typeof value === 'string') {
        let result = value.split(root).join('[LOCAL_RUNTIME]');
        for (const secret of secretValues) result = result.split(secret).join('[REDACTED]');
        return result.replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, '[REDACTED]').slice(0, 8192);
      }
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key,
        /(?:token|secret|password|private.?key)/i.test(key) ? '[REDACTED]' : scrub(item)]));
      return value;
    };
    return scrub(structuredClone(this.#snapshot)) as DesktopSetupSnapshot;
  }
}
