import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { AuthenticationCommandHandoff } from '@propr/cli/desktop-local-setup';

interface TerminalCandidate {
  command: string;
  args(title: string, command: string, args: string[]): string[];
}

const terminals: TerminalCandidate[] = [
  { command: 'x-terminal-emulator', args: (title, command, args) => ['-T', title, '-e', command, ...args] },
  { command: 'gnome-terminal', args: (title, command, args) => ['--wait', `--title=${title}`, '--', command, ...args] },
  { command: 'konsole', args: (title, command, args) => ['--nofork', '-p', `tabtitle=${title}`, '-e', command, ...args] },
  { command: 'xterm', args: (title, command, args) => ['-T', title, '-e', command, ...args] },
];

const abortError = (): Error => Object.assign(new Error('Authentication was cancelled.'), { name: 'AbortError' });

const stopProcessGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already exited */ } }
};

const tryTerminal = (
  terminal: TerminalCandidate,
  command: string,
  args: string[],
  title: string,
  signal?: AbortSignal,
): Promise<number | null | undefined> => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const child = spawn(terminal.command, terminal.args(title, command, args), {
    stdio: 'ignore',
    detached: true,
  });
  let admitted = false;
  let forceKill: NodeJS.Timeout | undefined;
  const abort = () => {
    stopProcessGroup(child, 'SIGTERM');
    forceKill = setTimeout(() => stopProcessGroup(child, 'SIGKILL'), 1_000);
    forceKill.unref();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const cleanup = () => {
    signal?.removeEventListener('abort', abort);
    if (forceKill) clearTimeout(forceKill);
  };
  child.once('spawn', () => { admitted = true; });
  child.once('error', error => {
    cleanup();
    if (signal?.aborted) reject(abortError());
    else if (!admitted && (error as NodeJS.ErrnoException).code === 'ENOENT') resolve(undefined);
    else reject(error);
  });
  child.once('close', status => {
    cleanup();
    if (signal?.aborted) reject(abortError());
    else resolve(status);
  });
});

/** Open interactive authentication in a real desktop terminal without blocking Electron's main loop. */
export const launchDesktopAuthentication: AuthenticationCommandHandoff = async (command, args, options) => {
  for (const terminal of terminals) {
    const status = await tryTerminal(terminal, command, args, options.title, options.signal);
    if (status !== undefined) return { status };
  }
  throw new Error('No supported desktop terminal is installed. Install x-terminal-emulator, GNOME Terminal, Konsole, or xterm and retry.');
};
