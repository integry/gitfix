import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const electronExecutable = require('electron');
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'electron-frame-semantics-probe.cjs');

const executableOnPath = name => (process.env.PATH ?? '')
  .split(delimiter)
  .map(directory => resolve(directory, process.platform === 'win32' ? `${name}.exe` : name))
  .find(existsSync);

const runFixture = (command, args) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.once('error', error => {
    clearTimeout(timer);
    rejectRun(error);
  });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (code !== 0) {
      rejectRun(new Error(`Electron frame fixture failed (${String(code ?? signal)}): ${stderr.slice(-2_000)}`));
      return;
    }
    const reportLine = stdout.trim().split(/\r?\n/u).findLast(line => line.startsWith('{'));
    if (!reportLine) {
      rejectRun(new Error(`Electron frame fixture did not report evidence: ${stderr.slice(-2_000)}`));
      return;
    }
    resolveRun(JSON.parse(reportLine));
  });
});

describe('Electron BrowserWindow lifecycle semantics', () => {
  it('keeps initial frame identity stable and invalidates the window getter after destruction', {
    timeout: 25_000,
  }, async context => {
    const xvfbRun = process.platform === 'linux' && !process.env.DISPLAY
      ? executableOnPath('xvfb-run')
      : undefined;
    if (process.platform === 'linux' && !process.env.DISPLAY && !xvfbRun) {
      context.skip('Electron needs DISPLAY or xvfb-run on Linux');
      return;
    }
    const electronArguments = [
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
      fixture,
    ];
    const report = xvfbRun
      ? await runFixture(xvfbRun, ['--auto-servernum', electronExecutable, ...electronArguments])
      : await runFixture(electronExecutable, electronArguments);

    assert.deepEqual(report, {
      navigationStarted: {
        detailsIsFirst: true,
        deprecatedUrlIsSecond: true,
        isMainFrame: true,
        isSameDocument: false,
        detailsFrameMatchesGetter: true,
        initialFrameMatchesGetter: true,
        initialDocumentIdMatches: true,
      },
      navigationCommitted: {
        firstGetterMatchesSecondGetter: true,
        initialFrameMatchesGetter: true,
        initialDocumentIdMatches: true,
      },
      readiness: {
        senderFrameMatchesFirstGetter: true,
        firstGetterMatchesSecondGetter: true,
        initialFrameMatchesGetter: true,
        initialDocumentIdMatches: true,
      },
      teardown: {
        initialNavigationCompleted: true,
        windowDestroyed: true,
        cachedWebContentsAccessible: true,
        getterError: {
          name: 'TypeError',
          message: 'Object has been destroyed',
        },
      },
    });
  });
});
