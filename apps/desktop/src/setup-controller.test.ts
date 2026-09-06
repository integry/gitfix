import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

describe('desktop local setup controller', () => {
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
});
