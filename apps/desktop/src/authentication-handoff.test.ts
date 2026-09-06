import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createDesktopAuthenticationLauncher, type TerminalCandidate } from './authentication-handoff';

const writeExecutable = async (path: string, source: string): Promise<void> => {
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
};

const serverBackedTerminal = (command: string): TerminalCandidate => ({
  command,
  // This fixture has the defining behavior of a server-capable terminal: it
  // admits the child elsewhere, then its launcher exits immediately.
  args: (_title, childCommand, args) => [childCommand, ...args],
});

const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path)).length > 0) return;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for controlled authentication fixture');
};

const waitForProcessExit = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Controlled authentication process was not reaped');
};

describe('desktop terminal authentication handoff', () => {
  it('waits for the actual command after a server-capable terminal launcher exits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-handoff-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const completed = join(directory, 'completed');
    try {
      await writeExecutable(terminal, '#!/bin/sh\n"$@" >/dev/null 2>&1 &\nexit 0\n');
      await writeExecutable(authentication, `#!/bin/sh\nsleep 0.2\nprintf complete > "${completed}"\n`);
      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);
      let settled = false;
      const handoff = launch(authentication, [], { title: 'Controlled authentication' })
        .finally(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 75));
      assert.equal(settled, false, 'terminal launcher exit was mistaken for authentication completion');
      assert.deepEqual(await handoff, { status: 0 });
      assert.equal(await readFile(completed, 'utf8'), 'complete');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('cancels and reaps the actual command owned by a server-capable terminal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-cancel-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const pidPath = join(directory, 'authentication.pid');
    const controller = new AbortController();
    try {
      await writeExecutable(terminal, '#!/bin/sh\n"$@" >/dev/null 2>&1 &\nexit 0\n');
      await writeExecutable(authentication, `#!/bin/sh\nprintf '%s' "$$" > "${pidPath}"\ntrap 'exit 143' TERM INT HUP\nwhile :; do sleep 1; done\n`);
      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);
      const handoff = launch(authentication, [], { title: 'Controlled authentication', signal: controller.signal });
      await waitForFile(pidPath);
      const pid = Number(await readFile(pidPath, 'utf8'));
      controller.abort();
      await assert.rejects(handoff, error => (error as Error).name === 'AbortError');
      await waitForProcessExit(pid);
    } finally {
      controller.abort();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
