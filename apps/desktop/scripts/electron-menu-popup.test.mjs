import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { prepareNativeElectronTest } from './electron-native-test-setup.mjs';

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'electron-menu-popup-probe.cjs');
const probeReadyMarker = 'PROPR_MENU_POPUP_PROBE_READY';
const startupDeadlineMilliseconds = 30_000;
const operationDeadlineMilliseconds = 15_000;

const runFixture = (command, args, env = process.env) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, {
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let deadline = 'startup';
  let deadlineExceeded;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', value => { stderr += value; });
  const killProcessGroup = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  let timer = setTimeout(() => {
    deadlineExceeded = `${startupDeadlineMilliseconds}ms startup`;
    killProcessGroup();
  }, startupDeadlineMilliseconds);
  child.stdout.on('data', value => {
    stdout += value;
    if (deadline === 'startup' && stdout.includes(probeReadyMarker)) {
      deadline = 'native operation';
      clearTimeout(timer);
      timer = setTimeout(() => {
        deadlineExceeded = `${operationDeadlineMilliseconds}ms native operation`;
        killProcessGroup();
      }, operationDeadlineMilliseconds);
    }
  });
  child.once('error', error => {
    clearTimeout(timer);
    rejectRun(error);
  });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (code !== 0) {
      const timeout = deadlineExceeded ? ` exceeded its ${deadlineExceeded} deadline` : '';
      rejectRun(new Error(
        `Electron menu popup probe${timeout} failed (${String(code ?? signal)}) during ${deadline}: ${stderr.slice(-2_000)}`,
      ));
      return;
    }
    const reportLine = stdout.trim().split(/\r?\n/u).findLast(line => line.startsWith('{'));
    if (!reportLine) {
      rejectRun(new Error(`Electron menu popup probe did not report evidence: ${stderr.slice(-2_000)}`));
      return;
    }
    resolveRun(JSON.parse(reportLine));
  });
});

describe('Electron Linux tray menu popup', () => {
  it('opens and dismisses production BrowserWindow owners through Linux tray activation', {
    timeout: 2 * (startupDeadlineMilliseconds + operationDeadlineMilliseconds) + 5_000,
  }, async context => {
    const setup = prepareNativeElectronTest({
      headlessReason: 'Electron needs a real DISPLAY or xvfb-run for the native menu boundary',
      linuxOnly: true,
      unsupportedPlatformReason: 'The tray workaround is Linux-specific',
    });
    if ('skipReason' in setup) {
      context.skip(setup.skipReason);
      return;
    }
    const reports = [];
    // Exercise both Electron activation-event shapes in complete native app
    // lifecycles. Reusing one process lets destruction of the first focused
    // owner race XFWM's pending desktop-focus fallback against the next menu.
    for (const activationIndex of [0, 1]) {
      const electronArguments = ['--no-sandbox', '--disable-gpu', fixture];
      const environment = {
        ...process.env,
        PROPR_MENU_POPUP_ACTIVATION_INDEX: String(activationIndex),
      };
      reports.push(setup.xvfbRun
        ? await runFixture(
            setup.xvfbRun,
            ['--auto-servernum', setup.electronExecutable, ...electronArguments],
            environment,
          )
        : await runFixture(setup.electronExecutable, electronArguments, environment));
    }

    const expectedEvidence = {
      menuWillShow: 1,
      menuWillClose: 1,
      trayActivations: 1,
      opensAfterActivationDispatch: 1,
      persistentDismissals: 1,
      ownersCreated: 1,
      ownersMapped: 1,
      ownersFocused: 1,
      ownersDestroyed: 1,
      browserWindowOwners: 1,
      toolbarOwners: 1,
      menusShownWithFocusedOwner: 1,
      trayDestroyed: true,
    };
    assert.deepEqual(reports, [
      { probeCase: 'empty-event/direct-dismissal', ...expectedEvidence },
      { probeCase: 'modifier-event/controller-teardown', ...expectedEvidence },
    ]);
  });
});
