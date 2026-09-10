import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import session from 'express-session';
import { chromium } from 'playwright';
import knex from 'knex';
import { closeConnection } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { McpStore } from '../mcp/store.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { mountMcpBrowser } from '../mcp/browser.js';
import { configureDemoMode } from '../demoMode.js';

after(async () => closeConnection());

test('real consent and connected-app routes work at desktop/mobile widths and enforce CSRF and revocation', async () => {
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath());
  assert.ok(existsSync(executablePath), 'Install Chromium with npx playwright install --with-deps chromium or set CHROMIUM_PATH');
  configureDemoMode(false);
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary()); await up(db);
  await db.schema.createTable('instance_members', table => { table.string('github_user_id').primary(); table.string('role'); table.string('source'); });
  const app = express();
  app.use(session({ secret: randomBytes(32).toString('hex'), resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { req.user = { id: '123', username: 'demo-developer', login: 'demo-developer', displayName: 'Demo developer', email: null, avatarUrl: null, accessToken: 'fixture-only' }; req.isAuthenticated = (() => true) as never; next(); });
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oauth = new McpOAuthProvider(new McpStore(db, randomBytes(32)), { origin, resource: `${origin}/api/mcp`, instanceId: 'development-instance', encryptionKey: randomBytes(32) });
  mountMcpBrowser(app, oauth, { accessibleRepositories: async () => ['acme/web-app', 'acme/api-service'] });
  const client = await oauth.clientsStore.registerClient!({ client_name: 'Development chat client', token_endpoint_auth_method: 'none', redirect_uris: ['https://client.example/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  const verifier = randomBytes(32).toString('base64url');
  let consent = '';
  await oauth.authorize(client, { redirectUri: client.redirect_uris[0], resource: new URL(`${origin}/api/mcp`), codeChallenge: createHash('sha256').update(verifier).digest('base64url'), scopes: ['read', 'plan', 'execute'] }, { redirect: (url: string) => { consent = url; } } as never);
  let browser;
  try {
    browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
    const page = await context.newPage();
    await page.goto(consent);
    assert.equal(await page.getByRole('heading', { name: 'Connect an app' }).count(), 1);
    const rejected = await context.request.post(`${origin}/mcp/consent`, { form: { csrf: 'wrong', request: new URL(consent).searchParams.get('request')!, decision: 'approve', repositories: 'acme/web-app' }, headers: { Origin: origin } });
    assert.equal(rejected.status(), 403);
    assert.equal(await page.getByLabel('read (required)', { exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel('plan', { exact: true }).isChecked(), false);
    assert.equal(await page.getByLabel('execute', { exact: true }).isChecked(), false);
    // A forged form cannot add unrequested permissions, even with valid CSRF.
    const csrf = await page.locator('input[name=csrf]').inputValue();
    const escalation = await context.request.post(`${origin}/mcp/consent`, { form: {
      csrf, request: new URL(consent).searchParams.get('request')!, decision: 'approve', repositories: 'acme/web-app', scopes: 'merge'
    }, headers: { Origin: origin } });
    assert.equal(escalation.status(), 400);
    await page.getByLabel('plan', { exact: true }).check();
    await page.getByLabel('plan', { exact: true }).uncheck();
    await page.getByLabel('acme/web-app').check();
    const capture = process.env.MCP_CAPTURE_PREVIEWS === 'true';
    if (capture) { await mkdir('.propr/previews', { recursive: true }); await page.screenshot({ path: '.propr/previews/mcp-consent-desktop.png', fullPage: true }); }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (capture) await page.screenshot({ path: '.propr/previews/mcp-consent-mobile.png', fullPage: true });
    await page.route('https://client.example/callback*', route => route.fulfill({ body: 'OAuth test callback' }));
    await page.getByRole('button', { name: 'Allow selected access' }).click();
    await page.waitForURL('https://client.example/callback*', { timeout: 3000 }).catch(async () => { throw new Error(`Consent navigation failed: ${await page.locator('body').innerText()}`); });
    const code = new URL(page.url()).searchParams.get('code')!;
    const token = await oauth.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0], new URL(`${origin}/api/mcp`));
    assert.equal(token.scope, 'read');
    assert.deepEqual((await oauth.verifyAccessToken(token.access_token)).scopes, ['read']);
    await page.goto(`${origin}/mcp/apps`);
    assert.equal(await page.getByRole('heading', { name: 'Development chat client' }).count(), 1);

    await page.getByRole('button', { name: 'Revoke access' }).click();
    await page.getByText('No connected apps.').waitFor();
    await assert.rejects(oauth.verifyAccessToken(token.access_token));
    if (capture) await writeFile('.propr/previews/manifest.json', JSON.stringify({ previews: [
      { path: '.propr/previews/mcp-consent-desktop.png', title: 'MCP app consent', description: 'Actual consent route with optional permission checkboxes left unselected for read-only access, using fictional fixture data.' },
      { path: '.propr/previews/mcp-consent-mobile.png', title: 'Mobile MCP consent', description: 'Consent at a 390-pixel mobile viewport.' },
    ], toolSuggestions: [] }, null, 2));
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.destroy(); }
});
