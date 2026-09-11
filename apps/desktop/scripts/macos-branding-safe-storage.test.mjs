import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const runPhase = (electron, directory, phase) => new Promise((resolveRun, rejectRun) => {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  execFile(electron, [directory, phase], {
    env: environment, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
  }, (error, stdout) => {
    const line = stdout.trim().split(/\r?\n/u).findLast(value => value.startsWith('{'));
    let report;
    try { report = JSON.parse(line); } catch { /* report missing */ }
    if (error || !report || report.failed) {
      // Never forward native stdout/stderr or Error objects containing buffers.
      rejectRun(new Error(`Native safeStorage ${phase} failed; use an unlocked macOS test session (status: ${report?.failed ?? 'no report'}).`));
    } else resolveRun(report);
  });
});

const removeFixtureKey = service => new Promise((resolveRemoval, rejectRemoval) => {
  assert.match(service, /^propr-branding-test-[0-9a-f-]{36} ProPR(?: Desktop)? Safe Storage$/u);
  // Exact UUID-scoped synthetic service only; never delete any real ProPR item,
  // change ACLs, or change the user's default Keychain/search list.
  execFile('/usr/bin/security', ['delete-generic-password', '-s', service], {
    timeout: 10_000, killSignal: 'SIGKILL',
  }, error => {
    if (!error || error.code === 44) resolveRemoval(); // errSecItemNotFound
    else rejectRemoval(new Error('Could not remove a UUID-scoped fixture Keychain item'));
  });
});

it('native macOS safeStorage decrypts across old → branded → old launches and rejects a renamed namespace', {
  // Requires real Keychain access. Never silently substitute Linux basic_text
  // or JS crypto, which cannot detect a macOS app-name namespace regression.
  skip: process.platform !== 'darwin' ? 'Requires macOS Keychain' :
    process.env.PROPR_DESKTOP_MAC_SAFE_STORAGE_TEST !== '1' ? 'Opt in with PROPR_DESKTOP_MAC_SAFE_STORAGE_TEST=1 in an unlocked test session' : false,
  timeout: 150_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-branding-crypto-'));
  const namespace = `propr-branding-test-${randomUUID()}`;
  const manifest = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
  try {
    assert.equal(manifest.productName, 'ProPR Desktop');
    for (const name of ['userData', 'sessionData', 'logs']) await mkdir(join(directory, name));
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name: namespace, productName: `${namespace} ${manifest.productName}`, version: '1.0.0', main: 'main.cjs',
    }));
    await writeFile(join(directory, 'fixture.json'), JSON.stringify({ namespace, legacyName: manifest.productName }));
    await copyFile(join(desktop, 'scripts/macos-branding-safe-storage-probe.cjs'), join(directory, 'main.cjs'));
    await build({
      entryPoints: [join(desktop, 'src/macos-branding.ts')], outfile: join(directory, 'branding.cjs'),
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
    });
    const electron = require('electron');
    for (const phase of ['legacy-write', 'renamed-control', 'branded', 'legacy-read']) {
      const report = await runPhase(electron, directory, phase);
      assert.deepEqual(report, {
        phase, available: true,
        recovered: phase === 'legacy-write' ? null : phase !== 'renamed-control',
        legacyIdentity: phase !== 'renamed-control', pathsPreserved: true,
      }, `${phase}: real encryption continuity and internal identity must both hold`);
    }
  } finally {
    // Clean only this run's synthetic items, including the negative control.
    const cleanup = await Promise.allSettled([
      removeFixtureKey(`${namespace} ProPR Desktop Safe Storage`),
      removeFixtureKey(`${namespace} ProPR Safe Storage`),
      rm(directory, { recursive: true, force: true }),
    ]);
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
  }
});
