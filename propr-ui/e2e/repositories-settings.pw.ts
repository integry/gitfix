import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { MonitoredRepo } from '../src/api/proprApi';

async function stubRepositoryApis(page: Page, canManage = true) {
  let repos: MonitoredRepo[] = [
    { id: 'propr', name: 'integry/propr', enabled: true, autoFollowupOnFailedCi: false, visualPreview: { enabled: true, types: ['image'] } },
    { id: 'sdk', name: 'integry/integration-sdk', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
    { id: 'docs', name: 'integry/documentation', enabled: false, visualPreview: { enabled: true, types: ['image'] } },
  ];
  const writes: MonitoredRepo[][] = [];
  let chatLoads = 0;
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown;
    switch (path) {
      case '/api/auth/demo-mode': json = { demoMode: false }; break;
      case '/api/auth/user':
        json = { id: 'preview-user', username: 'preview', displayName: 'Preview User', permissions: canManage ? ['instance.manage_settings'] : [] };
        break;
      case '/api/config/repos':
        if (route.request().method() === 'POST') {
          repos = route.request().postDataJSON().repos_to_monitor;
          writes.push(repos);
        }
        json = { success: true, repos_to_monitor: repos };
        break;
      case '/api/instance/catalog': json = { repositories: repos, agents: [] }; break;
      case '/api/github/repos': json = { repos: [] }; break;
      case '/api/user/repo-preferences': json = { preferences: { 'integry/propr': { starred: true } } }; break;
      case '/api/repositories/indexing-status':
        json = { repositories: repos.map(repo => ({
          full_name: repo.name, branch: 'HEAD', indexing_status: 'completed',
          last_indexed_at: new Date().toISOString(), last_indexed_hash: '8a6fe50123456789', last_indexed_commit_message: 'Update repository',
        })) };
        break;
      case '/api/repos/chat/messages': chatLoads++; json = { messages: [] }; break;
      case '/api/notifications/unread-count': json = { unreadCount: 0 }; break;
      default:
        await route.fulfill({ status: 503, json: { error: 'Optional API unavailable in repository UI test' } });
        return;
    }
    await route.fulfill({ json });
  });
  return { writes, chatLoads: () => chatLoads };
}

test('keeps navigation compact and saves settings for the selected repository', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await stubRepositoryApis(page);
  await page.goto('/repositories');
  await expect(page.getByRole('region', { name: /Settings for/ })).toHaveCount(0);
  const propr = page.getByRole('button', { name: 'Select integry/propr', exact: true });
  const sdk = page.getByRole('button', { name: 'Select integry/integration-sdk', exact: true });
  const originalHeight = (await propr.locator('../..').boundingBox())!.height;
  expect(originalHeight).toBe((await sdk.locator('../..').boundingBox())!.height);
  await propr.click();
  const settings = page.getByRole('region', { name: 'Settings for integry/propr', exact: true });
  await expect(settings).toBeVisible();
  await expect(propr.locator('../..').getByRole('checkbox')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  await expect.poll(api.chatLoads).toBeGreaterThan(0);
  const initialChatLoads = api.chatLoads();
  await settings.getByText('Auto CI follow-up', { exact: true }).click();
  await settings.getByRole('textbox').fill('Capture separate desktop and mobile views.');
  await settings.getByRole('button', { name: 'Videos', exact: true }).click();
  await expect.poll(() => api.writes.at(-1)?.[0].visualPreview).toEqual({
    enabled: true, types: ['image', 'video'], instructions: 'Capture separate desktop and mobile views.',
  });
  expect(api.writes.at(-1)?.[0].autoFollowupOnFailedCi).toBe(true);
  expect(api.writes.at(-1)?.[1].visualPreview?.enabled).toBe(false);
  expect(api.chatLoads()).toBe(initialChatLoads);
  expect((await propr.locator('../..').boundingBox())!.height).toBe(originalHeight);

  await sdk.click();
  const sdkSettings = page.getByRole('region', { name: 'Settings for integry/integration-sdk', exact: true });
  await expect(sdkSettings.getByRole('textbox')).toHaveCount(0);
  await sdkSettings.getByText('Visual previews', { exact: true }).click();
  await expect(sdkSettings.getByRole('textbox')).toHaveValue('');
  await propr.click();
  await expect(settings.getByRole('textbox')).toHaveValue('Capture separate desktop and mobile views.');
  await page.mouse.move(1400, 850);
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    await page.screenshot({ path: '../.propr/previews/repositories-desktop.png' });
  }
});

for (const width of [320, 390]) {
  test(`keeps repository settings usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const api = await stubRepositoryApis(page);
    await page.goto('/repositories');
    await page.getByRole('button', { name: 'Select integry/propr', exact: true }).click();
    const settings = page.getByRole('region', { name: 'Settings for integry/propr', exact: true });
    await expect(settings.getByRole('textbox')).toBeVisible();
    await settings.getByRole('textbox').fill('Capture the mobile navigation.');
    await settings.getByText('Auto CI follow-up', { exact: true }).click();
    await expect.poll(() => api.writes.at(-1)?.[0].autoFollowupOnFailedCi).toBe(true);
    await expect(page.getByText('Saved', { exact: true }).filter({ visible: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const box = (await settings.getByRole('textbox').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    if (width === 390 && process.env.PROPR_CAPTURE_PREVIEWS) {
      await page.screenshot({ path: '../.propr/previews/repositories-mobile.png' });
    }
    await page.getByRole('button', { name: 'Back to repositories' }).click();
    await expect(page.getByRole('button', { name: 'Select integry/propr', exact: true })).toBeVisible();
  });
}

test('keeps settings unavailable to read-only users', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubRepositoryApis(page, false);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select integry/propr', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: /Settings for/ })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Monitor integry/propr', exact: true })).toBeDisabled();
});
