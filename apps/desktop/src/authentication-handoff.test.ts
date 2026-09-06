import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
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
  it('preserves terminal stdin for an interactive authentication command', { skip: process.platform !== 'linux' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-pty-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const completed = join(directory, 'completed');
    try {
      await writeExecutable(terminal, '#!/bin/sh\nprintf "approved\\n" | script -qfec "\\"$1\\" \\"$2\\" \\"$3\\"" /dev/null >/dev/null 2>&1\n');
      await writeExecutable(authentication, `#!/bin/sh\n[ -t 0 ] || exit 91\nIFS= read -r answer || exit 92\n[ "$answer" = approved ] || exit 93\nprintf interactive > "${completed}"\n`);

      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);
      assert.deepEqual(await launch(authentication, [], { title: 'Controlled interactive authentication' }), { status: 0 });
      assert.equal(await readFile(completed, 'utf8'), 'interactive');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it('cancels and reaps a TERM-resistant command owned by a server-capable terminal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-cancel-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const pidPath = join(directory, 'authentication.pid');
    const controller = new AbortController();
    try {
      await writeExecutable(terminal, '#!/bin/sh\n"$@" >/dev/null 2>&1 &\nexit 0\n');
      await writeExecutable(authentication, `#!/bin/sh\nprintf '%s' "$$" > "${pidPath}"\ntrap '' TERM INT HUP\nwhile :; do sleep 1; done\n`);
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

  it('lets a published completion win a concurrent cancellation request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-race-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const readyPath = join(directory, 'authentication.ready');
    const triggerPath = join(directory, 'authentication.finish');
    const controller = new AbortController();
    try {
      await writeExecutable(terminal, '#!/bin/sh\n"$@" >/dev/null 2>&1 &\nexit 0\n');
      await writeExecutable(authentication, `#!/bin/sh\nprintf ready > "${readyPath}"\nwhile [ ! -f "${triggerPath}" ]; do sleep 0.01; done\nexit 0\n`);
      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);
      const handoff = launch(authentication, [], { title: 'Controlled completion race', signal: controller.signal });
      await waitForFile(readyPath);
      writeFileSync(triggerPath, '', { mode: 0o600 });
      const blockUntil = Date.now() + 150;
      while (Date.now() < blockUntil) { /* let the external wrapper publish while JS polling is paused */ }
      controller.abort();
      assert.deepEqual(await handoff, { status: 0 });
    } finally {
      controller.abort();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('drains a TERM-resistant command after the terminal sends HUP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-auth-hup-test-'));
    const terminal = join(directory, 'terminal');
    const authentication = join(directory, 'authentication');
    const pidPath = join(directory, 'authentication.pid');
    try {
      await writeExecutable(terminal, `#!/bin/sh\n"$@" >/dev/null 2>&1 &\nwrapper=$!\nwhile [ ! -f "${pidPath}" ]; do sleep 0.01; done\nkill -HUP "$wrapper"\nwait "$wrapper"\n`);
      await writeExecutable(authentication, `#!/bin/sh\nprintf '%s' "$$" > "${pidPath}"\ntrap '' TERM INT HUP\nwhile :; do sleep 1; done\n`);
      const launch = createDesktopAuthenticationLauncher([serverBackedTerminal(terminal)]);
      const handoff = launch(authentication, [], { title: 'Controlled terminal close' });
      await waitForFile(pidPath);
      const pid = Number(await readFile(pidPath, 'utf8'));
      assert.deepEqual(await handoff, { status: 137 });
      await waitForProcessExit(pid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
