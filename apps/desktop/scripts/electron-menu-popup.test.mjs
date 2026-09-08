import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { prepareNativeElectronTest } from './electron-native-test-setup.mjs';

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'electron-menu-popup-probe.cjs');

const runFixture = (command, args) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  child.once('error', error => {
    clearTimeout(timer);
    rejectRun(error);
  });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (code !== 0) {
      rejectRun(new Error(`Electron menu popup probe failed (${String(code ?? signal)}): ${stderr.slice(-2_000)}`));
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
  it('opens and closes createLinuxTrayMenuPopup owners through the native menu runner', {
    timeout: 20_000,
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
    const electronArguments = ['--no-sandbox', '--disable-gpu', fixture];
    const report = setup.xvfbRun
      ? await runFixture(setup.xvfbRun, ['--auto-servernum', setup.electronExecutable, ...electronArguments])
      : await runFixture(setup.electronExecutable, electronArguments);

    assert.deepEqual(report, {
      menuWillShow: 2,
      menuWillClose: 2,
      ownersCreated: 2,
      ownersMapped: 2,
      ownersDestroyed: 2,
    });
  });
});
