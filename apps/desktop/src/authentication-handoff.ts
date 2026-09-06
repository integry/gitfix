import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticationCommandHandoff } from '@propr/cli/desktop-local-setup';

export interface TerminalCandidate {
  command: string;
  args(title: string, command: string, args: string[]): string[];
}

const terminals: TerminalCandidate[] = [
  { command: 'x-terminal-emulator', args: (title, command, args) => ['-T', title, '-e', command, ...args] },
  { command: 'gnome-terminal', args: (title, command, args) => ['--wait', `--title=${title}`, '--', command, ...args] },
  { command: 'konsole', args: (title, command, args) => ['--nofork', '-p', `tabtitle=${title}`, '-e', command, ...args] },
  { command: 'xterm', args: (title, command, args) => ['-T', title, '-e', command, ...args] },
];

const START_TIMEOUT_MS = 5_000;
const FORCE_KILL_AFTER_MS = 1_000;
const POLL_INTERVAL_MS = 25;

// A terminal such as xfce4-terminal can hand the command to an existing server
// and exit before that command finishes. Keep the command lifecycle in this
// wrapper instead of treating the terminal launcher's close event as success.
// Every caller-controlled value remains a positional argv entry; none is
// interpolated into shell source.
const commandWrapper = `#!/bin/sh
set -u
state_base=$1
shift
started_file="\${state_base}.started"
result_file="\${state_base}.result"
cancel_file="\${state_base}.cancel"
umask 077
if command -v setsid >/dev/null 2>&1; then
  setsid -- "$@" &
  child=$!
  mode=group
else
  "$@" &
  child=$!
  mode=process
fi
printf '%s:%s\n' "$mode" "$child" > "$started_file"
terminate() {
  if [ "$mode" = group ]; then
    kill -TERM "-$child" 2>/dev/null || true
  else
    kill -TERM "$child" 2>/dev/null || true
  fi
}
trap terminate HUP INT TERM
if [ -f "$cancel_file" ]; then
  terminate
fi
set +e
wait "$child"
status=$?
set -e
printf '%s\n' "$status" > "$result_file"
exit "$status"
`;

const abortError = (): Error => Object.assign(new Error('Authentication was cancelled.'), { name: 'AbortError' });
const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

const stopProcessGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already exited */ } }
};

const readOwnedMarker = async (path: string): Promise<string | null> => {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

interface StartedCommand {
  mode: 'group' | 'process';
  pid: number;
}

const parseStartedCommand = (value: string | null): StartedCommand | null => {
  const match = /^(group|process):([1-9][0-9]{0,9})\n?$/.exec(value ?? '');
  if (!match) return null;
  const pid = Number(match[2]);
  return Number.isSafeInteger(pid) ? { mode: match[1] as StartedCommand['mode'], pid } : null;
};

const parseStatus = (value: string | null): number | null => {
  if (!/^[0-9]{1,3}\n?$/.test(value ?? '')) return null;
  const status = Number(value);
  return Number.isSafeInteger(status) && status >= 0 && status <= 255 ? status : null;
};

const stopStartedCommand = (started: StartedCommand, signal: NodeJS.Signals): void => {
  try { process.kill(started.mode === 'group' ? -started.pid : started.pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

const tryTerminal = async (
  terminal: TerminalCandidate,
  command: string,
  args: string[],
  title: string,
  signal?: AbortSignal,
): Promise<number | null | undefined> => {
  signal?.throwIfAborted();
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'propr-desktop-auth-'));
  const wrapperPath = join(runtimeDirectory, 'run-authentication');
  const stateBase = join(runtimeDirectory, 'command');
  const cancelPath = `${stateBase}.cancel`;
  let terminalChild: ChildProcess | null = null;
  let terminalClosed = false;
  let terminalStatus: number | null = null;
  let started: StartedCommand | null = null;
  let cancellationWritten = false;
  let forceKillAt = 0;
  try {
    await writeFile(wrapperPath, commandWrapper, { mode: 0o700, flag: 'wx' });
    const admission = await new Promise<'spawned' | 'missing'>((resolve, reject) => {
      const child = spawn(terminal.command, terminal.args(title, wrapperPath, [stateBase, command, ...args]), {
        stdio: 'ignore',
        detached: true,
      });
      terminalChild = child;
      child.once('spawn', () => resolve('spawned'));
      child.once('error', error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') resolve('missing');
        else reject(error);
      });
      child.once('close', status => {
        terminalClosed = true;
        terminalStatus = status;
      });
    });
    if (admission === 'missing') return undefined;

    const startDeadline = Date.now() + START_TIMEOUT_MS;
    while (true) {
      started ??= parseStartedCommand(await readOwnedMarker(`${stateBase}.started`));
      const aborted = signal?.aborted === true;
      if (aborted && !cancellationWritten) {
        await writeFile(cancelPath, '', { mode: 0o600, flag: 'wx' });
        cancellationWritten = true;
        // Once the wrapper has reported the real child, leave its terminal
        // process alive long enough to reap that child and publish the result.
        // Before then, the terminal group is the only process we can own.
        if (started) stopStartedCommand(started, 'SIGTERM');
        else if (terminalChild) stopProcessGroup(terminalChild, 'SIGTERM');
        forceKillAt = Date.now() + FORCE_KILL_AFTER_MS;
      }
      if (aborted && started && forceKillAt > 0 && Date.now() >= forceKillAt) {
        stopStartedCommand(started, 'SIGKILL');
        forceKillAt = Number.POSITIVE_INFINITY;
      }

      const status = parseStatus(await readOwnedMarker(`${stateBase}.result`));
      if (status !== null) {
        if (aborted) throw abortError();
        return status;
      }
      if (!started && terminalClosed && terminalStatus !== 0) {
        if (aborted) throw abortError();
        return terminalStatus;
      }
      if (!started && Date.now() >= startDeadline) {
        if (aborted) throw abortError();
        return terminalStatus === null ? null : terminalStatus || 1;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    if (signal?.aborted && terminalChild && !started) stopProcessGroup(terminalChild, 'SIGKILL');
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
};

/** Build a launcher with injectable candidates for controlled terminal-server lifecycle tests. */
export const createDesktopAuthenticationLauncher = (
  terminalCandidates: readonly TerminalCandidate[] = terminals,
): AuthenticationCommandHandoff => async (command, args, options) => {
  for (const terminal of terminalCandidates) {
    const status = await tryTerminal(terminal, command, args, options.title, options.signal);
    if (status !== undefined) return { status };
  }
  throw new Error('No supported desktop terminal is installed. Install x-terminal-emulator, GNOME Terminal, Konsole, or xterm and retry.');
};

/** Open interactive authentication in a real desktop terminal without blocking Electron's main loop. */
export const launchDesktopAuthentication: AuthenticationCommandHandoff = createDesktopAuthenticationLauncher();
