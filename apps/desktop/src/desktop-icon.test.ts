import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NativeImage } from 'electron';
import {
  DESKTOP_ICON_FILE,
  loadDesktopWindowIcon,
  resolveLinuxDesktopIconPath,
} from './desktop-icon';

describe('native desktop window icon', () => {
  it('resolves the copied resource in packaged Linux execution', () => {
    assert.equal(resolveLinuxDesktopIconPath({
      isPackaged: true,
      mainBundleDirectory: '/opt/propr/resources/app.asar/.vite/build',
      resourcesPath: '/opt/propr/resources',
    }), `/opt/propr/resources/${DESKTOP_ICON_FILE}`);
  });

  it('resolves the tracked desktop asset from the Vite development build', () => {
    assert.equal(resolveLinuxDesktopIconPath({
      isPackaged: false,
      mainBundleDirectory: '/checkout/apps/desktop/.vite/build',
      resourcesPath: '/electron/resources',
    }), `/checkout/apps/desktop/assets/icons/${DESKTOP_ICON_FILE}`);
  });

  it('loads and validates the exact Linux NativeImage used by BrowserWindow', () => {
    const image = {
      getSize: () => ({ width: 512, height: 512 }),
      isEmpty: () => false,
    } as NativeImage;
    let loadedPath = '';
    const result = loadDesktopWindowIcon({
      platform: 'linux',
      isPackaged: true,
      mainBundleDirectory: '/ignored',
      resourcesPath: '/app/resources',
      nativeImage: {
        createFromPath: path => {
          loadedPath = path;
          return image;
        },
      },
    });
    assert.equal(loadedPath, `/app/resources/${DESKTOP_ICON_FILE}`);
    assert.equal(result?.image, image);
    assert.deepEqual(result?.size, { width: 512, height: 512 });
  });

  it('fails closed when the packaged Linux icon cannot be decoded at its canonical size', () => {
    assert.throws(() => loadDesktopWindowIcon({
      platform: 'linux',
      isPackaged: true,
      mainBundleDirectory: '/ignored',
      resourcesPath: '/app/resources',
      nativeImage: {
        createFromPath: () => ({
          getSize: () => ({ width: 0, height: 0 }),
          isEmpty: () => true,
        }) as NativeImage,
      },
    }), /must load as 512x512/);
  });

  it('leaves deferred Windows and native macOS window handling unchanged', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      let attempted = false;
      assert.equal(loadDesktopWindowIcon({
        platform,
        isPackaged: true,
        mainBundleDirectory: '/ignored',
        resourcesPath: '/ignored',
        nativeImage: {
          createFromPath: () => {
            attempted = true;
            throw new Error('must not load');
          },
        },
      }), undefined);
      assert.equal(attempted, false);
    }
  });
});
