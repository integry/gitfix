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
wrapper=$$
if [ -t 0 ]; then
  # Keep the command in the terminal's session so /dev/tty remains its
  # controlling terminal. Starting a new session here preserves the tty file
  # descriptor but makes interactive programs unable to open /dev/tty.
  "$@" </dev/tty &
  mode=process
elif command -v setsid >/dev/null 2>&1; then
  setsid -- "$@" &
  mode=group
else
  "$@" &
  mode=process
fi
child=$!
terminating=0
force_killer=
cancel_watcher=
child_start=
observed_child_parent=
observed_child_start=
load_child_identity() {
  stat_line=
  if [ -r "/proc/$child/stat" ]; then
    IFS= read -r stat_line < "/proc/$child/stat" || return 1
    stat_rest=\${stat_line##*) }
    set -- $stat_rest
    [ "$#" -ge 20 ] || return 1
    observed_child_parent=$2
    shift 19
    observed_child_start=$1
    return 0
  fi
  observed_child_parent=$(ps -o ppid= -p "$child" 2>/dev/null) || return 1
  observed_child_parent=$(printf '%s' "$observed_child_parent" | tr -d '[:space:]')
  observed_child_start=unavailable
}
if load_child_identity && [ "$observed_child_parent" = "$wrapper" ]; then
  child_start=$observed_child_start
fi
printf '%s:%s\n' "$mode" "$child" > "$started_file"
child_is_owned() {
  [ -n "$child_start" ] || return 1
  load_child_identity || return 1
  [ "$observed_child_parent" = "$wrapper" ] && [ "$observed_child_start" = "$child_start" ]
}
signal_child() {
  child_is_owned || return 1
  if [ "$mode" = group ]; then
    kill -TERM "-$child" 2>/dev/null
  else
    kill -TERM "$child" 2>/dev/null
  fi
}
force_kill_child() {
  child_is_owned || return 0
  if [ "$mode" = group ]; then
    kill -KILL "-$child" 2>/dev/null || true
  else
    kill -KILL "$child" 2>/dev/null || true
  fi
}
terminate() {
  if [ "$terminating" -ne 0 ]; then
    return
  fi
  terminating=1
  if signal_child; then
    (
      trap 'exit 0' TERM
      trap '' HUP INT
      sleep 1
      force_kill_child
    ) &
    force_killer=$!
  fi
}
trap terminate HUP INT TERM
(
  trap 'exit 0' TERM
  trap '' HUP INT
  while [ ! -f "$cancel_file" ]; do sleep 0.025; done
  kill -TERM "$wrapper" 2>/dev/null || true
) &
cancel_watcher=$!

status=127
while :; do
  wait "$child"
  status=$?
  if ! child_is_owned; then
    break
  fi
done

kill -TERM "$cancel_watcher" 2>/dev/null || true
wait "$cancel_watcher" 2>/dev/null || true
if [ -n "$force_killer" ]; then
  if child_is_owned; then
    wait "$force_killer" 2>/dev/null || true
  else
    kill -TERM "$force_killer" 2>/dev/null || true
    wait "$force_killer" 2>/dev/null || true
  fi
fi
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

const hasStartedCommand = (value: string | null): boolean => {
  const match = /^(group|process):([1-9][0-9]{0,9})\n?$/.exec(value ?? '');
  if (!match) return false;
  const pid = Number(match[2]);
  return Number.isSafeInteger(pid);
};

const parseStatus = (value: string | null): number | null => {
  if (!/^[0-9]{1,3}\n?$/.test(value ?? '')) return null;
  const status = Number(value);
  return Number.isSafeInteger(status) && status >= 0 && status <= 255 ? status : null;
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
  let started = false;
  let completed = false;
  let cancellationWritten = false;
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
      const status = parseStatus(await readOwnedMarker(`${stateBase}.result`));
      if (status !== null) {
        completed = true;
        if (cancellationWritten) throw abortError();
        return status;
      }

      started ||= hasStartedCommand(await readOwnedMarker(`${stateBase}.started`));
      if (signal?.aborted && !cancellationWritten) {
        await writeFile(cancelPath, '', { mode: 0o600, flag: 'wx' });
        cancellationWritten = true;
      }
      if (!started && terminalClosed && terminalStatus !== 0) {
        if (signal?.aborted) throw abortError();
        return terminalStatus;
      }
      if (!started && Date.now() >= startDeadline) {
        if (signal?.aborted) throw abortError();
        return terminalStatus === null ? null : terminalStatus || 1;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    if (signal?.aborted && !completed && terminalChild && !terminalClosed && !started) {
      stopProcessGroup(terminalChild, 'SIGKILL');
    }
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
