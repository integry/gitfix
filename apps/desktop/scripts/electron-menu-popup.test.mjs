import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const electronExecutable = require('electron');
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'electron-menu-popup-probe.cjs');

const executableOnPath = name => (process.env.PATH ?? '')
  .split(delimiter)
  .map(directory => resolve(directory, name))
  .find(existsSync);

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

describe('Electron native Menu popup semantics', () => {
  it('opens and closes the real native menu also installed on a Linux Tray', {
    timeout: 20_000,
  }, async context => {
    if (process.platform !== 'linux') {
      context.skip('The tray workaround is Linux-specific');
      return;
    }
    const xvfbRun = !process.env.DISPLAY ? executableOnPath('xvfb-run') : undefined;
    if (!process.env.DISPLAY && !xvfbRun) {
      context.skip('Electron needs a real DISPLAY or xvfb-run for the native menu boundary');
      return;
    }
    const electronArguments = ['--no-sandbox', '--disable-gpu', fixture];
    const report = xvfbRun
      ? await runFixture(xvfbRun, ['--auto-servernum', electronExecutable, ...electronArguments])
      : await runFixture(electronExecutable, electronArguments);

    assert.deepEqual(report, {
      menuWillShow: 1,
      menuWillClose: 1,
      popupCallback: 1,
    });
  });
});
