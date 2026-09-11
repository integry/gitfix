import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { MonitoredRepo } from '../src/api/proprApi';

async function stubRepositoryApis(page: Page, canManage = true) {
  let repos: MonitoredRepo[] = [
    { id: 'propr', name: 'integry/propr', enabled: true, autoFollowupOnFailedCi: false, visualPreview: { enabled: true, types: ['image'] } },
    { id: 'sdk', name: 'integry/integration-sdk', enabled: true, baseBranch: 'main', visualPreview: { enabled: false, types: ['image'] } },
    { id: 'docs', name: 'integry/documentation', enabled: false, visualPreview: { enabled: true, types: ['image'] } },
  ];
  const writes: MonitoredRepo[][] = [];
  let chatLoads = 0;
  const indexingWrites: { path: string; body: unknown }[] = [];
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
      case '/api/config/repos/trigger-indexing':
      case '/api/config/repos/stop-indexing':
        indexingWrites.push({ path, body: route.request().postDataJSON() });
        json = { success: true };
        break;
      case '/api/instance/catalog': json = { repositories: repos, agents: [] }; break;
      case '/api/github/repos': json = { repos: [] }; break;
      case '/api/user/repo-preferences': json = { preferences: { 'integry/propr': { starred: true } } }; break;
      case '/api/repositories/indexing-status':
        json = { repositories: repos.map((repo, index) => ({
          full_name: repo.name, branch: repo.baseBranch || 'HEAD', indexing_status: 'completed',
          last_indexed_at: new Date(Date.now() - (index + 1) * 3600000).toISOString(), last_indexed_hash: '8a6fe50123456789', last_indexed_commit_message: 'Update repository',
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
  return { writes, indexingWrites, chatLoads: () => chatLoads };
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
  await expect(propr.locator('../..').getByText('8a6fe50', { exact: true })).toBeVisible();
  await expect(propr.locator('../..').locator('time')).toHaveText('1h ago');
  await propr.click();
  const settings = page.getByRole('region', { name: 'Settings for integry/propr', exact: true });
  await expect(settings).toHaveCount(0);
  await expect(propr.locator('../..').getByRole('checkbox')).toHaveCount(0);
  await expect(propr.locator('../..').getByRole('button')).toHaveCount(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings).toBeVisible();
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
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /Automatic CI follow-up/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reindex repository', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings.getByRole('textbox')).toHaveValue('Capture separate desktop and mobile views.');
  await page.mouse.move(1400, 850);
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    await page.screenshot({ animations: 'disabled', path: '../.propr/previews/repositories-desktop.png' });
  }
});

for (const width of [320, 390]) {
  test(`keeps repository settings usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const api = await stubRepositoryApis(page);
    await page.goto('/repositories');
    await page.getByRole('button', { name: 'Select integry/propr', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
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
      await page.screenshot({ animations: 'disabled', path: '../.propr/previews/repositories-mobile.png' });
    }
    await settings.getByRole('button', { name: 'Reindex repository', exact: true }).scrollIntoViewIfNeeded();
    await expect(settings.getByRole('button', { name: 'Reindex repository', exact: true })).toBeInViewport();
    await settings.getByRole('button', { name: 'Remove repository', exact: true }).scrollIntoViewIfNeeded();
    await expect(settings.getByRole('button', { name: 'Remove repository', exact: true })).toBeInViewport();
    if (width === 390 && process.env.PROPR_CAPTURE_PREVIEWS) {
      await page.screenshot({ animations: 'disabled', path: '../.propr/previews/repositories-mobile-indexing.png' });
    }
    await page.getByRole('button', { name: 'Back to repositories' }).click();
    await expect(page.getByRole('button', { name: 'Select integry/propr', exact: true })).toBeVisible();
  });
}

test('keeps repository and indexing changes unavailable to read-only users', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubRepositoryApis(page, false);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select integry/propr', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: /Settings for/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Monitor integry/propr', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Star repository', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Hide repository', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reindex repository', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Remove repository', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: /Automatic CI follow-up|Visual previews/ })).toHaveCount(0);
});


test('reindexes and stops indexing the selected repository branch from Settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await stubRepositoryApis(page);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select integry/integration-sdk', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings for integry/integration-sdk', exact: true });
  await expect(settings.getByText('main', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Reindex repository', exact: true }).click();
  await expect.poll(() => api.indexingWrites[0]).toEqual({
    path: '/api/config/repos/trigger-indexing',
    body: { repository: 'integry/integration-sdk', baseBranch: 'main', fullReindex: true },
  });
  await expect(settings.getByRole('button', { name: 'Reindex repository', exact: true })).toBeDisabled();
  page.once('dialog', dialog => dialog.accept());
  await settings.getByRole('button', { name: 'Stop indexing', exact: true }).click();
  await expect.poll(() => api.indexingWrites[1]).toEqual({
    path: '/api/config/repos/stop-indexing',
    body: { repository: 'integry/integration-sdk', branch: 'main' },
  });
  await page.getByRole('button', { name: 'Select integry/propr', exact: true }).click();
  const proprSettings = page.getByRole('region', { name: 'Settings for integry/propr', exact: true });
  await expect(proprSettings.getByRole('button', { name: 'Reindex repository', exact: true })).toBeEnabled();
  await expect(proprSettings.getByRole('button', { name: 'Stop indexing', exact: true })).toHaveCount(0);
});

test('saves monitoring and confirms removal from Settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await stubRepositoryApis(page);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select integry/propr', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings for integry/propr', exact: true });
  await settings.getByRole('checkbox', { name: 'Monitor integry/propr', exact: true }).uncheck();
  await expect.poll(() => api.writes.at(-1)?.[0].enabled).toBe(false);
  expect(api.writes.at(-1)?.[1].enabled).toBe(true);
  await settings.getByRole('button', { name: 'Remove repository', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Remove repository', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect.poll(() => api.writes.at(-1)?.map(repo => repo.name)).toEqual(['integry/integration-sdk', 'integry/documentation']);
  await expect(page.getByRole('button', { name: 'Select integry/propr', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: /Settings for/ })).toHaveCount(0);
});
