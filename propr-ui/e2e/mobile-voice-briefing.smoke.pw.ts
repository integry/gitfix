import { expect, test, type Page } from '@playwright/test';

const timestamp = '2026-09-07T09:35:00.000Z';
const notificationPreferences = {
  preferences: Object.fromEntries([
    'plan',
    'task',
    'review',
    'pull_request',
    'indexing',
    'system_failure',
  ].map(kind => [kind, {
    inboxEnabled: true,
    pushEnabled: false,
    updatedAt: timestamp,
  }])),
  quietHours: { start: null, end: null, timezone: 'UTC' },
  badgeEnabled: true,
};

const voiceCapabilities = {
  mode: 'on_demand',
  serverAudio: false,
  persistentSession: false,
  rawAudioAccepted: false,
  transcriptStored: false,
} as const;

const briefing = {
  generatedAt: timestamp,
  scope: 'all',
  headline: 'Two tasks need your attention',
  speechText: 'Two tasks need your attention. Task 1 has failed checks. Task 2 is blocked.',
  counts: { running: 1, queued: 0, attention: 2, plans: 0, total: 2 },
  items: [
    {
      reference: 'task 1',
      position: 1,
      kind: 'task',
      id: 'task-1',
      title: 'Repair mobile voice coverage',
      repository: 'integry/propr',
      status: 'attention',
      summary: 'The mobile voice briefing checks need review.',
      href: '/tasks/task-1',
      requiresAttention: true,
      actions: ['open', 'stop', 'follow_up'],
      updatedAt: '2026-09-07T09:30:00.000Z',
    },
    {
      reference: 'task 2',
      position: 2,
      kind: 'task',
      id: 'task-2',
      title: 'Verify the text fallback',
      repository: 'integry/propr',
      status: 'blocked',
      summary: 'Browser speech APIs are unavailable in this smoke test.',
      href: '/tasks/task-2',
      requiresAttention: true,
      actions: ['open', 'stop', 'follow_up'],
      updatedAt: '2026-09-07T09:25:00.000Z',
    },
  ],
};

async function stubVoiceBriefingSmokeApis(
  page: Page,
  onBriefingRequest: (request: { method: string; scope: string | null }) => void,
): Promise<void> {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;

    // Match the demo authentication and notification stubs used by the PWA
    // browser smoke suite so this remains independent of a running backend.
    if (pathname === '/api/auth/demo-mode') {
      await route.fulfill({ json: { demoMode: true } });
      return;
    }
    if (pathname === '/api/notifications/unread-count') {
      await route.fulfill({ json: { unreadCount: 3 } });
      return;
    }
    if (pathname === '/api/notifications/preferences') {
      await route.fulfill({ json: notificationPreferences });
      return;
    }
    if (pathname === '/api/notifications') {
      await route.fulfill({
        json: { notifications: [], unreadCount: 3, nextCursor: null },
      });
      return;
    }
    if (pathname === '/api/voice/capabilities') {
      await route.fulfill({ json: voiceCapabilities });
      return;
    }
    if (pathname === '/api/voice/briefing') {
      onBriefingRequest({
        method: request.method(),
        scope: url.searchParams.get('scope'),
      });
      await route.fulfill({ json: briefing });
      return;
    }

    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable in browser smoke test' }),
    });
  });
}

test('keeps the Voice Briefing text fallback usable on a narrow mobile viewport', async ({ page }) => {
  const briefingRequests: Array<{ method: string; scope: string | null }> = [];

  await page.setViewportSize({ width: 320, height: 720 });
  await page.addInitScript(() => {
    // Headless environments differ in which partial speech globals they expose.
    // Remove all of them so this exercises the supported visual-only fallback.
    for (const property of [
      'speechSynthesis',
      'SpeechSynthesisUtterance',
      'SpeechRecognition',
      'webkitSpeechRecognition',
    ]) {
      Object.defineProperty(window, property, {
        configurable: true,
        value: undefined,
        writable: true,
      });
    }
  });
  await stubVoiceBriefingSmokeApis(page, request => briefingRequests.push(request));
  await page.goto('/inbox');

  const mobileNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  const launcher = page.getByRole('button', { name: 'Voice briefing' });
  await expect(mobileNavigation).toBeVisible();
  await expect(launcher).toBeVisible();

  const placement = await page.evaluate(() => {
    const launcherElement = document.querySelector<HTMLElement>('[aria-label="Voice briefing"]');
    const navigationElement = document.querySelector<HTMLElement>('nav[aria-label="Primary navigation"]');
    if (!launcherElement || !navigationElement) throw new Error('Mobile controls did not render');
    const launcherRect = launcherElement.getBoundingClientRect();
    const navigationRect = navigationElement.getBoundingClientRect();
    return {
      launcher: {
        top: launcherRect.top,
        right: launcherRect.right,
        bottom: launcherRect.bottom,
        left: launcherRect.left,
      },
      navigationTop: navigationRect.top,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  expect(placement.launcher.left).toBeGreaterThanOrEqual(0);
  expect(placement.launcher.top).toBeGreaterThanOrEqual(0);
  expect(placement.launcher.right).toBeLessThanOrEqual(placement.viewport.width);
  expect(placement.launcher.bottom).toBeLessThanOrEqual(placement.navigationTop);
  expect(placement.launcher.bottom).toBeLessThanOrEqual(placement.viewport.height);

  expect(briefingRequests).toHaveLength(0);
  await launcher.click();

  const dialog = page.getByRole('dialog', { name: 'Voice briefing' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Before you use voice recognition' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Listen' })).toBeDisabled();
  await expect(page.getByText(/Voice commands aren’t supported/)).toBeVisible();
  await expect(page.getByText(/Spoken playback isn’t supported/)).toBeVisible();
  expect(briefingRequests).toHaveLength(0);

  await page.getByRole('button', { name: 'I understand' }).click();
  await expect(page.getByRole('heading', { name: 'Before you use voice recognition' })).toBeHidden();
  expect(briefingRequests).toHaveLength(0);

  await page.getByRole('button', { name: 'Catch me up' }).click();
  await expect.poll(() => briefingRequests).toEqual([{ method: 'GET', scope: 'all' }]);
  await expect(page.getByRole('heading', { name: briefing.headline })).toBeVisible();

  const briefingItems = page.getByRole('list', { name: 'Briefing items' });
  await expect(briefingItems).toBeVisible();
  await expect(briefingItems).toHaveJSProperty('tagName', 'OL');
  await expect(briefingItems.getByRole('listitem')).toHaveCount(2);
  await expect(briefingItems.getByText(/^t1$/i)).toBeVisible();
  await expect(briefingItems.getByText(/^t2$/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Repeat' })).toBeDisabled();

  const dialogBox = await dialog.boundingBox();
  if (!dialogBox) throw new Error('Voice Briefing dialog does not have a layout box');
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(placement.viewport.width);
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(placement.viewport.height);

  const pageWidth = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(pageWidth.document).toBeLessThanOrEqual(pageWidth.viewport);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(launcher).toBeFocused();

  const activityLink = mobileNavigation.getByRole('link', { name: 'Activity' });
  await expect(activityLink).toBeVisible();
  await activityLink.click();
  await expect(page).toHaveURL(/\/tasks$/);
});
