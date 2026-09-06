import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createDesktopSetupHost } from './desktopLocalSetup.js';
import type { CapturedCommandRunner } from './auth/githubLogin.js';

const fixtureDirectory = (): string => realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-desktop-host-')));

describe('desktop setup host authentication boundary', () => {
  it('hands unauthenticated GitHub startup to a visible asynchronous host action', async () => {
    const configDir = fixtureDirectory();
    const calls: string[] = [];
    let tokenChecks = 0;
    const capturedCommand: CapturedCommandRunner = async (command, args) => {
      calls.push([command, ...args].join(' '));
      if (args[0] === '--version') return { status: 0, stdout: 'gh version fixture' };
      tokenChecks += 1;
      return { status: tokenChecks === 1 ? 1 : 0, stdout: tokenChecks === 1 ? '' : 'fixture-token\n' };
    };
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const admitted = new Promise<void>(resolve => { release = resolve; });
    try {
      const host = await createDesktopSetupHost({
        configDir,
        capturedCommand,
        authenticationHandoff: async (command, args) => {
          calls.push(`visible:${[command, ...args].join(' ')}`);
          markStarted();
          await admitted;
          return { status: 0 };
        },
      });
      assert.equal(host.actions.hasGithubToken(), false);
      const login = host.actions.loginWithGithub();
      await started;
      assert.match(calls.at(-1) ?? '', /^visible:gh auth login/);
      assert.equal(host.actions.hasGithubToken(), false);
      release();
      assert.equal(await login, true);
      assert.equal(host.actions.hasGithubToken(), true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('aborts and reaps a production Docker operation without waiting for its natural exit', async () => {
    const directory = fixtureDirectory();
    const docker = join(directory, 'docker');
    const pidPath = join(directory, 'docker.pid');
    const originalPath = process.env.PATH;
    let pid: number | undefined;
    writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.PROPR_TEST_DOCKER_PID, String(process.pid));
process.on('SIGTERM', () => undefined);
setInterval(() => undefined, 1000);
`, { mode: 0o700 });
    chmodSync(docker, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ''}`;
    process.env.PROPR_TEST_DOCKER_PID = pidPath;
    const controller = new AbortController();
    let operation: Promise<unknown> | undefined;
    try {
      const rootDir = join(directory, 'root');
      mkdirSync(rootDir, { mode: 0o700 });
      const host = await createDesktopSetupHost({
        configDir: join(directory, 'config'),
        capturedCommand: async () => ({ status: 1, stdout: '' }),
        authenticationHandoff: async () => ({ status: 1 }),
      });
      operation = host.actions.pullImages({
        rootDir,
        agentTypes: [],
        signal: controller.signal,
      });
      const deadline = Date.now() + 2_000;
      while (!existsSync(pidPath) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(existsSync(pidPath), true, 'fixture Docker process did not start');
      pid = Number(readFileSync(pidPath, 'utf8'));

      controller.abort();
      await Promise.race([
        assert.rejects(operation, error => (error as Error).name === 'AbortError'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Docker cancellation did not settle')), 2_000)),
      ]);
      assert.throws(() => process.kill(pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
    } finally {
      process.env.PATH = originalPath;
      delete process.env.PROPR_TEST_DOCKER_PID;
      if (pid) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
      }
      await operation?.catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('cancels an admitted desktop authentication handoff without blocking the host', async () => {
    const configDir = fixtureDirectory();
    const controller = new AbortController();
    let admitted!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    try {
      const host = await createDesktopSetupHost({
        configDir,
        capturedCommand: async (_command, args) => ({ status: args[0] === '--version' ? 0 : 1, stdout: '' }),
        authenticationHandoff: async (_command, _args, options) => new Promise((_resolve, reject) => {
          admitted();
          options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
        }),
      });
      const login = host.actions.loginWithGithub({ signal: controller.signal });
      await started;
      controller.abort();
      await assert.rejects(login, error => (error as Error).name === 'AbortError');
      assert.equal(host.actions.hasGithubToken(), false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
