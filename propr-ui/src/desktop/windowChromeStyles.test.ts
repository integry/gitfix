import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopStyles = readFileSync(resolve(process.cwd(), 'src/desktop/desktop.css'), 'utf8');

const ruleFor = (selector: string): string => {
  const start = desktopStyles.indexOf(`\n${selector} {`);
  if (start < 0) return '';
  const bodyStart = desktopStyles.indexOf('{', start) + 1;
  const end = desktopStyles.indexOf('}', bodyStart);
  return desktopStyles.slice(bodyStart, end);
};

const zIndexFor = (selector: string): number => {
  const match = ruleFor(selector).match(/z-index:\s*(\d+)/);
  if (!match) throw new Error(`Missing z-index for ${selector}`);
  return Number(match[1]);
};

describe('desktop window chrome styles', () => {
  it('uses the Electron overlay safe rectangle with an exact Linux control fallback', () => {
    expect(ruleFor('.desktop-entry-drag-region')).toContain('left: env(titlebar-area-x, 0px)');
    expect(ruleFor('.desktop-entry-drag-region')).toContain('width: env(titlebar-area-width, 100%)');
    expect(ruleFor('.desktop-connected-drag-region')).toContain('left: env(titlebar-area-x, 0px)');
    expect(ruleFor('.desktop-connected-drag-region')).toContain('width: env(titlebar-area-width, 100%)');
    expect(desktopStyles).toContain('env(titlebar-area-height, 0px)');
    expect(desktopStyles).toContain('width: calc(100% - var(--desktop-window-controls-end-inset))');
  });

  it('makes the compact toolbar draggable while keeping every interactive control no-drag', () => {
    const chromeRule = ruleFor('.desktop-app .desktop-sidebar-header,\n.desktop-app .desktop-content-toolbar');
    expect(chromeRule).toContain('height: var(--desktop-titlebar-height)');
    expect(chromeRule).toContain('-webkit-app-region: drag');
    expect(desktopStyles).toMatch(/\.desktop-app \.desktop-content-toolbar :is\([^}]+\)\s*\{\s*-webkit-app-region: no-drag;/);
  });

  it('reserves the native controls at the toolbar end and the traffic lights at the macOS start', () => {
    expect(desktopStyles).toContain(
      '.desktop-app .desktop-content-toolbar {\n  padding-right: var(--desktop-window-controls-end-inset);',
    );
    expect(ruleFor('.desktop-app.desktop-platform-darwin .desktop-sidebar-header')).toContain(
      'env(titlebar-area-x, 5rem)',
    );
    expect(ruleFor('.desktop-window-controls')).toContain('-webkit-app-region: no-drag');
    expect(ruleFor('.desktop-window-controls')).toContain('height: var(--desktop-titlebar-height)');
  });

  it('keeps Linux window controls above application modal backdrops', () => {
    expect(zIndexFor('.desktop-window-controls')).toBeGreaterThan(zIndexFor('.desktop-modal-backdrop'));
  });
});
