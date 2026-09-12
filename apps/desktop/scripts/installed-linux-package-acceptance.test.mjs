import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  assertInstalledLinuxAcceptanceArtifact,
  cleanupOwnedContainer,
  createInstalledLinuxContainerInvocation,
  DEFAULT_LINUX_PACKAGE_IMAGES,
  INSTALLED_LINUX_ACCEPTANCE_OPT_IN,
  parseInstalledLinuxAcceptanceArguments,
  runInstalledLinuxPackageAcceptance,
} from './run-installed-linux-package-acceptance.mjs';

const canonicalArguments = directory => [
  '--arch', 'x64',
  '--previous-version', '1.2.2',
  '--version', '1.2.3',
  '--previous-deb', join(directory, 'ProPR-Desktop-1.2.2-linux-x64.deb'),
  '--deb', join(directory, 'ProPR-Desktop-1.2.3-linux-x64.deb'),
  '--previous-rpm', join(directory, 'ProPR-Desktop-1.2.2-linux-x64.rpm'),
  '--rpm', join(directory, 'ProPR-Desktop-1.2.3-linux-x64.rpm'),
];

describe('installed Linux package acceptance authority', () => {
  test('requires canonical artifacts and a strictly increasing native target', () => {
    const target = parseInstalledLinuxAcceptanceArguments(canonicalArguments('/private/artifacts'));
    assert.equal(target.arch, 'x64');
    assert.equal(target.previousVersion, '1.2.2');
    assert.equal(target.version, '1.2.3');
    assert.deepEqual(target.images, DEFAULT_LINUX_PACKAGE_IMAGES);
    assert.equal(target.artifacts.deb.current, '/private/artifacts/ProPR-Desktop-1.2.3-linux-x64.deb');

    for (const replacement of [
      ['--arch', 'ia32'],
      ['--previous-version', '1.2.3'],
      ['--version', '1.2.2'],
      ['--version', '1.2.3-beta.1'],
      ['--deb', '/private/artifacts/renamed.deb'],
      ['--rpm-image', 'registry.invalid/image@sha256:unsafe'],
    ]) {
      const args = canonicalArguments('/private/artifacts');
      const index = args.indexOf(replacement[0]);
      if (index >= 0) args[index + 1] = replacement[1];
      else args.push(...replacement);
      assert.throws(() => parseInstalledLinuxAcceptanceArguments(args), /invalid|canonical/);
    }
  });

  test('rejects empty files and linked artifact aliases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-installed-package-artifact-'));
    const artifact = join(directory, 'artifact.deb');
    const linked = join(directory, 'linked.deb');
    try {
      await writeFile(artifact, 'package');
      await assert.doesNotReject(assertInstalledLinuxAcceptanceArtifact(artifact));
      await symlink(artifact, linked);
      await assert.rejects(assertInstalledLinuxAcceptanceArtifact(linked), /non-link|canonical/);
      await assert.rejects(assertInstalledLinuxAcceptanceArtifact(`${artifact},injected`), /unsafe/);
      await writeFile(artifact, '');
      await assert.rejects(assertInstalledLinuxAcceptanceArtifact(artifact), /non-empty/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('mounts only the selected artifacts and harness read-only in an auto-removed container', () => {
    const target = parseInstalledLinuxAcceptanceArguments(canonicalArguments('/private/artifacts'));
    const invocation = createInstalledLinuxContainerInvocation({
      family: 'deb',
      target,
      isolationId: '0123456789abcdef',
    });
    assert.equal(invocation.name, 'propr-package-deb-0123456789abcdef');
    assert.equal(invocation.label, 'dev.propr.acceptance=0123456789abcdef');
    assert.deepEqual(invocation.args.slice(0, 8), [
      'run', '--rm', '--init', '--platform=linux/amd64', '--name', invocation.name,
      '--label', invocation.label,
    ]);
    const command = invocation.args.join('\n');
    assert.match(command, /test-installed-linux-package\.sh/);
    assert.match(command, /ProPR-Desktop-1\.2\.2-linux-x64\.deb/);
    assert.match(command, /ProPR-Desktop-1\.2\.3-linux-x64\.deb/);
    assert.doesNotMatch(command, /\.rpm/);
    assert.equal(command.match(/readonly/g)?.length, 3);
    assert.doesNotMatch(command, /--privileged|--no-sandbox|\/var\/run\/docker\.sock/);
  });

  test('fails before daemon or package operations without explicit opt-in', async () => {
    let calls = 0;
    await assert.rejects(runInstalledLinuxPackageAcceptance({ arch: process.arch }, {
      environment: {},
      runCommand: async () => { calls += 1; },
    }), new RegExp(INSTALLED_LINUX_ACCEPTANCE_OPT_IN));
    assert.equal(calls, 0);
  });

  test('removes only the exact labelled acceptance container', async () => {
    const invocation = {
      name: 'propr-package-deb-0123456789abcdef',
      label: 'dev.propr.acceptance=0123456789abcdef',
    };
    const calls = [];
    await cleanupOwnedContainer('/usr/bin/docker', invocation, async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === 'inspect') return { code: 0, stdout: '0123456789abcdef\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    assert.deepEqual(calls[1], ['/usr/bin/docker', 'rm', '--force', invocation.name]);

    const refused = [];
    await assert.rejects(cleanupOwnedContainer('/usr/bin/docker', invocation, async (file, args) => {
      refused.push([file, ...args]);
      return { code: 0, stdout: 'someone-elses-container\n', stderr: '' };
    }), /does not own/);
    assert.equal(refused.length, 1);
  });

  test('container harness proves package-manager lifecycle without weakening the sandbox', async () => {
    const source = await readFile(new URL('./test-installed-linux-package.sh', import.meta.url), 'utf8');
    assert.match(source, /\[ ! -f \/\.dockerenv \].*\/run\/\.containerenv/);
    assert.match(source, /apt-get install -y "\$package"/);
    assert.match(source, /dnf install -y "\$package"/);
    assert.match(source, /assert_mode_owner "\$sandbox" 4755/);
    assert.match(source, /assert_mode_owner "\$native_addon" 755/);
    assert.match(source, /x-scheme-handler\/propr/);
    assert.match(source, /run_installed_smoke before-upgrade[\s\S]*install_artifact "\$artifact"[\s\S]*run_installed_smoke after-upgrade/);
    assert.match(source, /remove_package[\s\S]*package manager still reports propr-desktop installed/);
    assert.match(source, /snapshot_owned_system_entries[\s\S]*database-owned system file behind/);
    assert.match(source, /package removal changed synthetic user configuration/);
    assert.doesNotMatch(source, /--no-sandbox|setenforce|sysctl|chmod .*\/proc|keyring|\.propr/);
  });
});
