import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { SetupActions } from '@propr/local-setup';
import { DesktopSetupController } from './setup-controller';
import type { DesktopSetupRequest } from './shared/contract';

const request: DesktopSetupRequest = {
  sessionId: '11111111-1111-4111-8111-111111111111', root: { mode: 'default' },
  reinitialize: false, agents: [], github: { mode: 'demo' }, intake: { mode: 'keep' },
  whitelist: null, repository: null,
};

const successfulActions = (rootDir: string): SetupActions => ({
  runChecks: async () => ({ rootDir, anyFail: false, cfg: {}, results: [
    { name: 'Docker installed', group: 'Docker', status: 'ok', detail: 'Docker version fixture' },
    { name: 'Docker daemon', group: 'Docker', status: 'ok', detail: 'Docker daemon fixture' },
  ] }),
  inspectStackInit: () => ({ rootDir, envExists: true, dirs: { data: true, logs: true, repos: true }, initialized: true }),
  inspectDatastoreAdministrators: async () => ({ status: 'has-admin', databasePath: join(rootDir, 'data', 'propr.sqlite') }),
  scaffoldStack: async () => { throw new Error('initialized fixture must not scaffold'); },
  persistStackRoot: async () => undefined,
  readEnvVars: () => ({ PROPR_DEMO_MODE: 'true', GITHUB_EVENT_INTAKE_MODE: 'polling' }),
  applyEnvSelection: () => ({ written: [], skipped: [] }),
  clearEnvKeys: () => undefined,
  detectGithubAuthMode: () => ({ mode: 'demo', warnings: [] }),
  prepareAgentCredentialDir: () => undefined,
  pullImages: async () => ({ pulledCore: ['propr/api'], pulledAgents: [], failedCore: [], failedAgents: [] }),
  isStackRunning: async () => true,
  startStack: async () => undefined,
  checkBackendHealth: async () => ({ healthy: true, detail: 'API healthy' }),
  addRepository: async () => undefined,
  resolveUiUrl: async () => 'http://localhost:3000',
  openUrl: async () => undefined,
  saveWhitelistSetting: async () => undefined,
  hasGithubToken: () => false,
  fetchRelayInstallations: async () => ({ username: 'fixture', installations: [] }),
  enrollRelay: async () => ({ relayUrl: 'https://relay.example.test', token: 'fixture-token' }),
  loginWithGithub: async () => false,
  listAgents: async () => [],
  addAgent: async () => undefined,
  loginableAgents: async () => [],
  loginAgent: async () => ({ available: false, success: false }),
  validateAgents: async () => [],
} as unknown as SetupActions);

const relayRequest: DesktopSetupRequest = {
  ...request, github: { mode: 'relay' }, intake: { mode: 'polling' },
};

const waitForSnapshot = async (
  controller: DesktopSetupController,
  predicate: (snapshot: Awaited<ReturnType<DesktopSetupController['status']>>) => boolean,
) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await controller.status();
    if (predicate(snapshot)) return snapshot;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for setup snapshot');
};

const relayActions = (rootDir: string, overrides: Partial<SetupActions> = {}): SetupActions => {
  const env: Record<string, string> = { GITHUB_EVENT_INTAKE_MODE: 'polling' };
  return {
    ...successfulActions(rootDir),
    readEnvVars: () => ({ ...env }),
    applyEnvSelection: (_root, vars) => {
      Object.assign(env, vars);
      return { written: Object.keys(vars), skipped: [] };
    },
    detectGithubAuthMode: () => env.GH_AUTH_MODE === 'relay'
      ? { mode: 'relay', warnings: [] } : { mode: 'none', warnings: [] },
    hasGithubToken: () => true,
    fetchRelayInstallations: async () => ({ username: 'fixture-user', installations: [
      { installation_id: 100, account_login: 'acme', account_type: 'Organization' },
      { installation_id: 200, account_login: 'fixture-user', account_type: 'User' },
    ] }),
    enrollRelay: async () => ({ relayUrl: 'https://relay.example.test', token: 'fixture-secret-token' }),
    ...overrides,
  } as SetupActions;
};

describe('desktop local setup controller', () => {
  it('publishes safe identity metadata and validates an explicit installation choice', async () => {
    const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-setup-controller-')));
    chmodSync(appData, 0o700);
    const rootDir = join(appData, 'local-runtime');
    let enrolledId: string | undefined;
    const controller = new DesktopSetupController({
      actions: relayActions(rootDir, { enrollRelay: async ({ installationId }) => {
        enrolledId = installationId;
        return { relayUrl: 'https://relay.example.test', token: 'fixture-secret-token' };
      } }),
      platform: 'linux', appDataDir: appData, defaultRootDir: rootDir,
      statePath: join(appData, 'setup', 'state.json'), sessionId: request.sessionId,
      selectPrivateKey: async () => null, promptWebhookSecret: async () => null,
      resolveApiBaseUrl: async () => 'http://localhost:4000', emit: () => undefined,
    });
    try {
      const running = controller.start(relayRequest);
      const choice = await waitForSnapshot(controller, value => value.githubIdentity?.status === 'selection-required');
      assert.equal(choice.githubIdentity?.username, 'fixture-user');
      assert.deepEqual(choice.githubIdentity?.installations.map(value => [value.accountLogin, value.accountType]), [
        ['acme', 'Organization'], ['fixture-user', 'User'],
      ]);
      assert.doesNotMatch(JSON.stringify(choice), /fixture-secret-token/);
      await assert.rejects(controller.resolveGithubInstallation({ action: 'select', installationId: '999' }), /current discovered list/);
      await controller.resolveGithubInstallation({ action: 'select', installationId: '200' });
      const completed = await running;
      assert.equal(completed.phase, 'completed');
      assert.equal(completed.githubIdentity?.status, 'enrolled');
      assert.equal(completed.resume?.github.mode === 'relay' && completed.resume.github.identity?.installation.accountLogin, 'fixture-user');
      assert.equal(enrolledId, '200');
    } finally { await controller.shutdown(); rmSync(appData, { recursive: true, force: true }); }
  });

  it('keeps install, refresh, and cancel actionable when discovery returns zero installations', async () => {
    const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-setup-controller-')));
    chmodSync(appData, 0o700);
    const rootDir = join(appData, 'local-runtime');
    const opened: string[] = [];
    let discoveries = 0;
    const controller = new DesktopSetupController({
      actions: relayActions(rootDir, {
        fetchRelayInstallations: async () => {
          discoveries += 1;
          return { username: 'fixture-user', installations: [] };
        },
        openUrl: async url => { opened.push(url); },
      }),
      platform: 'linux', appDataDir: appData, defaultRootDir: rootDir,
      statePath: join(appData, 'setup', 'state.json'), sessionId: request.sessionId,
      selectPrivateKey: async () => null, promptWebhookSecret: async () => null,
      resolveApiBaseUrl: async () => 'http://localhost:4000', emit: () => undefined,
    });
    try {
      const running = controller.start(relayRequest);
      const initial = await waitForSnapshot(controller, value => value.githubIdentity?.status === 'selection-required');
      assert.deepEqual(initial.githubIdentity?.installations, []);
      assert.equal(initial.githubIdentity?.installAvailable, true);

      const installing = await controller.resolveGithubInstallation({ action: 'install' });
      assert.equal(installing.githubIdentity?.status, 'installing');
      await waitForSnapshot(controller, value => discoveries >= 2 && value.githubIdentity?.status === 'selection-required');
      assert.deepEqual(opened, ['https://github.com/apps/propr-dev/installations/new']);

      const refreshing = await controller.resolveGithubInstallation({ action: 'refresh' });
      assert.equal(refreshing.githubIdentity?.status, 'refreshing');
      await waitForSnapshot(controller, value => discoveries >= 3 && value.githubIdentity?.status === 'selection-required');

      const cancelled = await controller.cancel();
      assert.equal((await running).phase, 'cancelled');
      assert.equal(cancelled.phase, 'cancelled');
      assert.equal(discoveries, 3);
    } finally { await controller.shutdown(); rmSync(appData, { recursive: true, force: true }); }
  });

  it('keeps an enrollment 403 in the chooser and settles cancellation without duplicate enrollment', async () => {
    const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-setup-controller-')));
    chmodSync(appData, 0o700);
    const rootDir = join(appData, 'local-runtime');
    let enrollmentCalls = 0;
    const controller = new DesktopSetupController({
      actions: relayActions(rootDir, { enrollRelay: async () => {
        enrollmentCalls += 1;
        throw Object.assign(new Error('owner only'), { status: 403 });
      } }),
      platform: 'linux', appDataDir: appData, defaultRootDir: rootDir,
      statePath: join(appData, 'setup', 'state.json'), sessionId: request.sessionId,
      selectPrivateKey: async () => null, promptWebhookSecret: async () => null,
      resolveApiBaseUrl: async () => 'http://localhost:4000', emit: () => undefined,
    });
    try {
      const running = controller.start(relayRequest);
      await waitForSnapshot(controller, value => value.githubIdentity?.status === 'selection-required');
      await controller.resolveGithubInstallation({ action: 'select', installationId: '100' });
      const denied = await waitForSnapshot(controller, value => value.githubIdentity?.status === 'authorization-failed');
      assert.match(denied.githubIdentity?.permissionExplanation ?? '', /installation owner/i);
      assert.equal(denied.phase, 'running');
      assert.equal(enrollmentCalls, 1);
      const cancelled = await controller.cancel();
      assert.equal((await running).phase, 'cancelled');
      assert.equal(cancelled.phase, 'cancelled');
      assert.equal(enrollmentCalls, 1);
      await assert.rejects(controller.resolveGithubInstallation({ action: 'refresh' }), /No GitHub installation choice/);
    } finally { await controller.shutdown(); rmSync(appData, { recursive: true, force: true }); }
  });

  it('cancels admitted engine work and allows a fresh retry without touching a real stack', async () => {
    const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-setup-controller-')));
    chmodSync(appData, 0o700);
    let attempts = 0;
    let started!: () => void;
    const actionStarted = new Promise<void>(resolve => { started = resolve; });
    const actions = {
      runChecks: async ({ signal }: { signal?: AbortSignal }) => {
        attempts += 1;
        if (attempts === 1) {
          started();
          await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
        }
        return { rootDir: join(appData, 'local-runtime'), anyFail: true,
          results: [{ name: 'Docker daemon', group: 'Docker', status: 'fail', detail: 'Start Docker and retry.' }] };
      },
    } as unknown as SetupActions;
    const controller = new DesktopSetupController({
      actions, platform: 'linux', appDataDir: appData, defaultRootDir: join(appData, 'local-runtime'),
      statePath: join(appData, 'setup', 'state.json'), sessionId: request.sessionId,
      selectPrivateKey: async () => null, promptWebhookSecret: async () => null,
      resolveApiBaseUrl: async () => 'http://localhost:4000', emit: () => undefined,
    });
    try {
      const running = controller.start(request);
      await actionStarted;
      const cancelled = await controller.cancel();
      assert.equal((await running).phase, 'cancelled');
      assert.equal(cancelled.phase, 'cancelled');

      const retried = await controller.retry();
      assert.equal(retried.phase, 'failed');
      assert.match(retried.state?.steps.find(step => step.id === 'check')?.nextAction ?? '', /Docker/);
      assert.equal(attempts, 2);
    } finally {
      await controller.shutdown();
      rmSync(appData, { recursive: true, force: true });
    }
  });

  it('reports remote-only capability and rejects setup outside Linux', async () => {
    const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-setup-controller-')));
    const controller = new DesktopSetupController({
      actions: {} as SetupActions, platform: 'win32', appDataDir: appData,
      defaultRootDir: join(appData, 'local-runtime'), statePath: join(appData, 'state.json'),
      sessionId: request.sessionId, selectPrivateKey: async () => null, promptWebhookSecret: async () => null,
      resolveApiBaseUrl: async () => 'http://localhost:4000', emit: () => undefined,
    });
    try {
      assert.equal((await controller.status()).phase, 'unsupported');
      await assert.rejects(controller.start(request), /not supported/);
    } finally { await controller.shutdown(); rmSync(appData, { recursive: true, force: true }); }
  });

  it('admits private-key resolution atomically and cancels it before host actions start', async () => {
    const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-setup-controller-')));
    chmodSync(appData, 0o700);
    const privateKey = join(appData, 'github-app.pem');
    writeFileSync(privateKey, 'private test fixture', { mode: 0o600 });
    let hostActions = 0;
    const controller = new DesktopSetupController({
      actions: { runChecks: async () => { hostActions += 1; throw new Error('must not run'); } } as unknown as SetupActions,
      platform: 'linux', appDataDir: appData, defaultRootDir: join(appData, 'local-runtime'),
      statePath: join(appData, 'setup', 'state.json'), sessionId: request.sessionId,
      selectPrivateKey: async () => privateKey, promptWebhookSecret: async () => null,
      resolveApiBaseUrl: async () => 'http://localhost:4000', emit: () => undefined,
    });
    try {
      const selection = await controller.selectPrivateKey();
      assert.ok(selection);
      const appRequest: DesktopSetupRequest = {
        ...request,
        github: { mode: 'app', appId: '123', installationId: '456', privateKeyCapability: selection.capability },
      };

      const running = controller.start(appRequest);
      await assert.rejects(controller.start(appRequest), /already running/);
      const cancelled = await controller.cancel();

      assert.equal((await running).phase, 'cancelled');
      assert.equal(cancelled.phase, 'cancelled');
      assert.equal(hostActions, 0);
    } finally {
      await controller.shutdown();
      rmSync(appData, { recursive: true, force: true });
    }
  });

  it('exposes credential review while preserving an ordinary transient retry', async () => {
    const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-setup-controller-')));
    chmodSync(appData, 0o700);
    const privateKey = join(appData, 'github-app.pem');
    writeFileSync(privateKey, 'private test fixture', { mode: 0o600 });
    const controller = new DesktopSetupController({
      actions: { runChecks: async () => ({ rootDir: join(appData, 'local-runtime'), anyFail: true,
        results: [{ name: 'Docker daemon', group: 'Docker', status: 'fail', detail: 'Transient daemon failure.' }] }) } as unknown as SetupActions,
      platform: 'linux', appDataDir: appData, defaultRootDir: join(appData, 'local-runtime'),
      statePath: join(appData, 'setup', 'state.json'), sessionId: request.sessionId,
      selectPrivateKey: async () => privateKey, promptWebhookSecret: async () => null,
      resolveApiBaseUrl: async () => 'http://localhost:4000', emit: () => undefined,
    });
    try {
      const selection = await controller.selectPrivateKey();
      assert.ok(selection);
      const failed = await controller.start({
        ...request,
        github: { mode: 'app', appId: '123', installationId: '456', privateKeyCapability: selection.capability },
      });
      assert.equal(failed.phase, 'failed');
      assert.equal(failed.reconfigurationRequired, true);
      assert.equal(failed.resume?.reconfigurationStage, 'github');
    } finally { await controller.shutdown(); rmSync(appData, { recursive: true, force: true }); }
  });

  it('restores the same completed profile after a controller restart', async () => {
    const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-setup-controller-')));
    chmodSync(appData, 0o700);
    const rootDir = join(appData, 'local-runtime');
    const statePath = join(appData, 'setup', 'state.json');
    const options = {
      actions: successfulActions(rootDir), platform: 'linux' as const, appDataDir: appData,
      defaultRootDir: rootDir, statePath, sessionId: request.sessionId,
      selectPrivateKey: async () => null, promptWebhookSecret: async () => null,
      resolveApiBaseUrl: async () => 'http://localhost:4000', emit: () => undefined,
    };
    const first = new DesktopSetupController(options);
    let restarted: DesktopSetupController | undefined;
    try {
      const completed = await first.start(request);
      assert.equal(completed.phase, 'completed');
      assert.ok(completed.profile);
      await first.shutdown();

      restarted = new DesktopSetupController(options);
      const restored = await restarted.status();
      assert.equal(restored.phase, 'completed');
      assert.deepEqual(restored.profile, completed.profile);
    } finally {
      await first.shutdown();
      await restarted?.shutdown();
      rmSync(appData, { recursive: true, force: true });
    }
  });

  it('turns an unresolvable persisted completion into explicit interrupted recovery', async () => {
    const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-setup-controller-')));
    chmodSync(appData, 0o700);
    const statePath = join(appData, 'setup', 'state.json');
    mkdirSync(join(appData, 'setup'), { mode: 0o700 });
    writeFileSync(statePath, `${JSON.stringify({
      version: 1, phase: 'completed', resume: {
        agents: [], reinitialize: false, github: { mode: 'demo' }, intake: { mode: 'keep' },
        whitelist: null, repository: null,
      },
    })}\n`, { mode: 0o600 });
    const controller = new DesktopSetupController({
      actions: {} as SetupActions, platform: 'linux', appDataDir: appData, defaultRootDir: join(appData, 'local-runtime'),
      statePath, sessionId: request.sessionId, selectPrivateKey: async () => null, promptWebhookSecret: async () => null,
      resolveApiBaseUrl: async () => 'http://localhost:4000', emit: () => undefined,
    });
    try {
      const restored = await controller.status();
      assert.equal(restored.phase, 'interrupted');
      assert.match(restored.error ?? '', /could not be restored/i);
      assert.equal(restored.resumeAvailable, true);
    } finally { await controller.shutdown(); rmSync(appData, { recursive: true, force: true }); }
  });
});
