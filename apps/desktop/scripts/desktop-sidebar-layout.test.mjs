import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import axe from 'axe-core';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import tailwindConfig from '../../../propr-ui/tailwind.config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Uses the shipped component and CSS with synthetic public identities only.
// Install: npx playwright install chromium
// Run: PROPR_DESKTOP_SIDEBAR_TEST=1 node --test apps/desktop/scripts/desktop-sidebar-layout.test.mjs
// Set PROPR_DESKTOP_SIDEBAR_PREVIEWS=1 to save focused evidence in .propr/previews.
it('keeps desktop selector identities, status and keyboard actions usable at narrow widths', {
  // Like the native frame suite, keep browser installation out of unit-only jobs.
  skip: process.env.PROPR_DESKTOP_SIDEBAR_TEST !== '1' && process.env.PROPR_DESKTOP_SIDEBAR_PREVIEWS !== '1'
    ? 'Set PROPR_DESKTOP_SIDEBAR_TEST=1 with Playwright Chromium installed'
    : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-sidebar-'));
  let browser;
  try {
    await build({
      stdin: {
        resolveDir: root, loader: 'tsx', contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { DesktopContext } from './propr-ui/src/desktop/DesktopContext';
          import { DesktopInstanceSelector } from './propr-ui/src/desktop/DesktopInstanceSelector';
          import './propr-ui/src/desktop/desktop.css';
          const root = createRoot(document.getElementById('root'));
          window.renderSelector = ({ platform, width, name, username, avatar, status, transportReady }) => {
            document.documentElement.dataset.desktopWindow = platform;
            window.selectorActions = [];
            const desktop = {
              isDesktop: true, platform: platform === 'darwin' ? 'macos' : platform,
              profile: { id: 'preview', name, baseUrl: 'https://preview.example', kind: 'remote',
                account: username ? { id: '101', username, avatarUrl: avatar ? 'https://preview.example/avatar.svg' : null } : undefined },
              connection: { status },
              openProfileManager: () => window.selectorActions.push('switch'),
              retry: () => window.selectorActions.push('retry'),
            };
            root.render(<div className={'desktop-app desktop-platform-' + platform}>
              <div className="desktop-shell-content"><aside style={{ width }}>
                <div className="desktop-sidebar-header" />
                <DesktopContext.Provider value={desktop}>
                  <DesktopInstanceSelector transportReady={transportReady} />
                </DesktopContext.Provider>
              </aside></div>
            </div>);
          };
        `,
      },
      outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife',
    });
    const base = await postcss([tailwind({ ...tailwindConfig, content: [join(root, 'propr-ui/src/**/*.{ts,tsx}')] })])
      .process(await readFile(join(root, 'propr-ui/src/index.css'), 'utf8'), { from: join(root, 'propr-ui/src/index.css') });
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#d4e8e4"/></svg>' }));
    await page.setContent('<!doctype html><html lang="en"><head><title>Sidebar layout test</title></head><body><div id="root"></div></body></html>');
    await page.addStyleTag({ content: base.css });
    await page.addStyleTag({ path: join(directory, 'renderer.css') });
    await page.addScriptTag({ path: join(directory, 'renderer.js') });
    const previews = [];
    const cases = [
      { platform: 'darwin', width: 240, viewport: 1280, name: 'Team development', username: 'preview-developer', avatar: true, status: 'ready', transportReady: true },
      { platform: 'linux', width: 240, viewport: 1024, name: 'Shared engineering development instance', username: 'preview-engineering-automation-account', avatar: true, status: 'ready', transportReady: true },
      { platform: 'darwin', width: 200, viewport: 800, name: 'LongUnbrokenDevelopmentInstanceNameForPreview', username: 'preview-engineering-automation-account', avatar: false, status: 'ready', transportReady: false },
      { platform: 'linux', width: 176, viewport: 640, name: 'LongUnbrokenDevelopmentInstanceNameForPreview', username: 'preview-engineering-automation-account', avatar: true, status: 'incompatible', transportReady: false },
      { platform: 'linux', width: 200, viewport: 640, name: 'Team development', username: null, avatar: false, status: 'offline', transportReady: false },
    ];
    for (const [index, state] of cases.entries()) {
      await page.setViewportSize({ width: state.viewport, height: 600 });
      await page.evaluate(state => window.renderSelector(state), state);
      const selector = page.locator('.desktop-instance-selector');
      const button = selector.getByRole('button');
      const label = state.status === 'incompatible' ? 'Update required' : state.status === 'offline' ? 'Offline' : state.transportReady ? 'Connected' : 'Reconnecting';
      await expect(button).toHaveAccessibleName(`${label}: ${state.name}`);
      await expect(button).toHaveAccessibleDescription(new RegExp(state.username || 'Retry connection'));
      await expect(selector.locator('.desktop-instance-status')).toHaveText(label);
      const geometry = await selector.evaluate(element => {
        const box = element.getBoundingClientRect();
        const selectors = ['button', '.desktop-instance-copy', '.desktop-instance-account', '.desktop-instance-footer', '.desktop-instance-status', '.desktop-instance-switch'];
        return {
          top: box.top, headerBottom: document.querySelector('.desktop-sidebar-header').getBoundingClientRect().bottom,
          fits: selectors.every(selector => [...element.querySelectorAll(selector)].every(child => {
            const bounds = child.getBoundingClientRect();
            return bounds.left >= box.left && bounds.right <= box.right && child.scrollWidth <= child.clientWidth + 1;
          })),
          statusBottom: element.querySelector('.desktop-instance-status').getBoundingClientRect().bottom,
          identityBottom: element.querySelector('.desktop-instance-account')?.getBoundingClientRect().bottom,
          nameHeight: element.querySelector('strong').getBoundingClientRect().height,
        };
      });
      assert.ok(geometry.fits, `No horizontal overflow for ${JSON.stringify(state)}`);
      assert.ok(geometry.top >= geometry.headerBottom, 'Selector stays below platform titlebar');
      assert.ok(geometry.nameHeight <= 40, 'Long instance names use at most two lines');
      if (geometry.identityBottom) assert.ok(geometry.statusBottom > geometry.identityBottom, 'Status remains separate from account identity');
      if (state.avatar) {
        await expect(selector.locator('img')).toHaveCSS('width', '20px');
      }
      // Start from the document so Tab, not programmatic focus, enters the control.
      await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
      await page.keyboard.press('Tab');
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS('outline-style', 'solid');
      await expect(button).toHaveCSS('outline-width', '2px');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      assert.deepEqual(await page.evaluate(() => window.selectorActions), Array(2).fill(state.status === 'ready' ? 'switch' : 'retry'));
      await page.addScriptTag({ content: axe.source });
      const accessibility = await page.evaluate(() => window.axe.run('.desktop-instance-selector', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
      assert.deepEqual(accessibility.violations.map(({ id }) => id), [], 'Selector passes focused accessibility checks');
      if (process.env.PROPR_DESKTOP_SIDEBAR_PREVIEWS === '1') {
        const name = `desktop-sidebar-${state.platform}-${state.width}-${index}.png`;
        await mkdir(join(root, '.propr/previews'), { recursive: true });
        await selector.screenshot({ path: join(root, '.propr/previews', name) });
        previews.push({ path: `.propr/previews/${name}`, title: `Desktop selector: ${state.platform === 'darwin' ? 'macOS' : 'Linux'}, ${state.width}px`, description: `Production selector rendered in Chromium with ${label.toLowerCase()} status and synthetic identity; keyboard focus visible. Platform CSS only, not a native OS capture.` });
      }
    }
    if (previews.length) await writeFile(join(root, '.propr/previews/manifest.json'), JSON.stringify({ previews, toolSuggestions: [] }, null, 2));
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
