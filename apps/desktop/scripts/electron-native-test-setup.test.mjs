import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { prepareNativeElectronTest } from './electron-native-test-setup.mjs';

describe('native Electron test setup', () => {
  it('keeps native probe modules free of eager Electron resolution', async () => {
    const probeSources = await Promise.all([
      'electron-frame-semantics.test.mjs',
    ].map(file => readFile(new URL(file, import.meta.url), 'utf8')));

    for (const source of probeSources) {
      assert.doesNotMatch(source, /['"]electron['"]/u);
    }
  });

  it('does not resolve Electron for an unsupported platform', () => {
    let resolutions = 0;
    const setup = prepareNativeElectronTest({
      linuxOnly: true,
      platform: 'darwin',
      resolveElectron: () => { resolutions += 1; },
      unsupportedPlatformReason: 'unsupported',
    });

    assert.deepEqual(setup, { skipReason: 'unsupported' });
    assert.equal(resolutions, 0);
  });

  it('does not resolve Electron for a headless Linux worker', () => {
    let resolutions = 0;
    const setup = prepareNativeElectronTest({
      environment: { PATH: '/missing' },
      findExecutable: () => undefined,
      headlessReason: 'headless',
      platform: 'linux',
      resolveElectron: () => { resolutions += 1; },
    });

    assert.deepEqual(setup, { skipReason: 'headless' });
    assert.equal(resolutions, 0);
  });

  it('resolves Electron once for a supported native worker', () => {
    let resolutions = 0;
    const setup = prepareNativeElectronTest({
      environment: {},
      findExecutable: () => assert.fail('macOS must not look for xvfb-run'),
      platform: 'darwin',
      resolveElectron: () => {
        resolutions += 1;
        return '/electron';
      },
    });

    assert.deepEqual(setup, {
      electronExecutable: '/electron',
      xvfbRun: undefined,
    });
    assert.equal(resolutions, 1);
  });

  it('preserves xvfb-run for a supported headless Linux worker', () => {
    const setup = prepareNativeElectronTest({
      environment: { PATH: '/tools' },
      findExecutable: () => '/tools/xvfb-run',
      platform: 'linux',
      resolveElectron: () => '/electron',
    });

    assert.deepEqual(setup, {
      electronExecutable: '/electron',
      xvfbRun: '/tools/xvfb-run',
    });
  });

  it('runs one Electron preflight before starting parallel test workers', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const testCommand = packageJson.scripts.test;
    const preflight = 'node scripts/electron-native-test-preflight.mjs';
    const workers = 'tsx --test';

    assert.equal(testCommand.split(preflight).length - 1, 1);
    assert.ok(testCommand.indexOf(preflight) < testCommand.indexOf(workers));
    assert.match(testCommand, /^node scripts\/electron-native-test-preflight\.mjs && tsx --test /u);
  });
});
