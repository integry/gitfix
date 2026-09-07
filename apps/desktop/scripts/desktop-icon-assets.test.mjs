import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CANONICAL_ICON_SHA256,
  DESKTOP_ICON_FILE,
  inspectIcnsBytes,
  MACOS_ICON_FILE,
  sha256,
  verifyDesktopPngBytes,
  verifyLinuxLauncherIcon,
  verifyMacApplicationIcon,
  verifyPackagedLinuxIcon,
} from './desktop-icon-assets.mjs';
import { buildDesktopIcons } from './generate-desktop-icons.mjs';

const iconDirectory = new URL('../assets/icons/', import.meta.url);

describe('desktop native icon assets', () => {
  it('wires the native assets into Forge, runtime BrowserWindow creation, and CI package checks', async () => {
    const [forge, main, workflow] = await Promise.all([
      readFile(new URL('../forge.config.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/main.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../.github/workflows/desktop-release-guard.yml', import.meta.url), 'utf8'),
    ]);
    assert.match(forge, /process\.platform === 'darwin' \? \{ icon: desktopMacIcon \} : \{\}/);
    assert.equal(forge.match(/icon: desktopLinuxIcon/g)?.length, 2);
    assert.match(forge, /extraResource: \[\s*desktopLinuxIcon,/);
    assert.match(main, /loadDesktopWindowIcon/);
    assert.match(main, /desktopWindowIcon\?\.image/);
    assert.equal(workflow.match(/icons:verify-packaged/g)?.length, 2);
  });

  it('are reproducibly derived from the pinned canonical ProPR PWA mark', async () => {
    const generated = await buildDesktopIcons();
    const [png, icns] = await Promise.all([
      readFile(new URL(DESKTOP_ICON_FILE, iconDirectory)),
      readFile(new URL(MACOS_ICON_FILE, iconDirectory)),
    ]);
    assert.equal(sha256(png), CANONICAL_ICON_SHA256);
    assert.deepEqual(verifyDesktopPngBytes(png), { width: 512, height: 512 });
    assert.deepEqual(inspectIcnsBytes(icns), {
      icp4: 16,
      icp5: 32,
      icp6: 64,
      ic07: 128,
      ic08: 256,
      ic09: 512,
      ic10: 1024,
    });
    assert.equal(png.equals(generated.png), true);
    assert.equal(icns.equals(generated.icns), true);
  });

  it('verifies packaged Linux runtime and launcher icon surfaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-icon-linux-'));
    try {
      const applicationRoot = join(root, 'usr', 'lib', 'propr-desktop');
      const resources = join(applicationRoot, 'resources');
      const applications = join(root, 'usr', 'share', 'applications');
      const pixmaps = join(root, 'usr', 'share', 'pixmaps');
      await Promise.all([mkdir(resources, { recursive: true }), mkdir(applications, { recursive: true }), mkdir(pixmaps, { recursive: true })]);
      const canonical = await readFile(new URL(DESKTOP_ICON_FILE, iconDirectory));
      await Promise.all([
        writeFile(join(resources, DESKTOP_ICON_FILE), canonical),
        writeFile(join(pixmaps, DESKTOP_ICON_FILE), canonical),
        writeFile(join(applications, 'propr-desktop.desktop'), [
          '[Desktop Entry]',
          'Name=ProPR Desktop',
          'Exec=propr-desktop %U',
          'Icon=propr-desktop',
          'MimeType=x-scheme-handler/propr;',
        ].join('\n')),
      ]);
      assert.equal(await verifyPackagedLinuxIcon(applicationRoot), join(resources, DESKTOP_ICON_FILE));
      await assert.doesNotReject(verifyLinuxLauncherIcon({
        desktopFile: join(applications, 'propr-desktop.desktop'),
        iconFile: join(pixmaps, DESKTOP_ICON_FILE),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('verifies macOS bundle metadata points at the complete ICNS resource', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-icon-macos-'));
    try {
      const resources = join(root, 'ProPR.app', 'Contents', 'Resources');
      await mkdir(resources, { recursive: true });
      await writeFile(join(resources, MACOS_ICON_FILE), await readFile(new URL(MACOS_ICON_FILE, iconDirectory)));
      const path = await verifyMacApplicationIcon({
        applicationRoot: join(root, 'ProPR.app'),
        readPlist: async key => {
          assert.equal(key, 'CFBundleIconFile');
          return MACOS_ICON_FILE;
        },
      });
      assert.equal(path, join(resources, MACOS_ICON_FILE));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
