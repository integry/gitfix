import express, { type Express, type Request, type Response } from 'express';
import { Octokit } from '@octokit/core';
import { loadMonitoredReposRaw } from '@propr/core';
import { isUserWhitelisted } from '../userWhitelist.js';
import { resolveInstanceAuthorization } from '../authorization.js';
import { createAuthRequestRateLimiter } from '../requestRateLimits.js';
import { isDemoMode } from '../demoMode.js';
import type { GitHubUser } from '../authTypes.js';
import { McpOAuthProvider, type McpGrant, type PendingAuthorization } from './oauth.js';
import { digest, secret } from './store.js';
import type { Artifact } from './toolsArtifacts.js';

const escape = (text: unknown): string => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
type ConsentSession = Request['session'] & { mcpCsrf?: string };

export function renderMcpPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ProPR</title><style>body{font:16px system-ui;background:#10151e;color:#edf2fa;margin:0;padding:24px}main{max-width:640px;margin:5vh auto;padding:28px;border:1px solid #344158;border-radius:16px;background:#192230}h1{font-size:28px}p,li{line-height:1.6;overflow-wrap:anywhere}label{display:block;padding:12px;border:1px solid #344158;border-radius:8px;margin:8px 0}input{margin-right:10px}button,a{font:inherit}button{background:#99d8be;color:#10231b;border:0;border-radius:8px;padding:12px 18px;margin:12px 12px 0 0;cursor:pointer}a{color:#a6d5ff}.secondary{background:#334155;color:white}small{color:#b4c2d8}article{border-top:1px solid #344158;margin-top:24px;padding-top:8px}@media(max-width:480px){body{padding:12px}main{margin:12px auto;padding:20px}button{width:100%}}</style><main><small>ProPR · Connected apps</small><h1>${escape(title)}</h1>${body}</main></html>`;
}

export function mountMcpBrowser(app: Express, oauth: McpOAuthProvider, overrides: { accessibleRepositories?: (user: GitHubUser) => Promise<string[]> } = {}): void {
  app.use('/mcp', createAuthRequestRateLimiter(), express.urlencoded({ extended: false, limit: '16kb' }), (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    if (isDemoMode()) { res.status(403).send('MCP grants are disabled in demo mode.'); return; }
    if (!req.isAuthenticated() || !req.user?.accessToken) {
      res.redirect(`/api/auth/github?redirectTo=${encodeURIComponent(oauth.config.origin + req.originalUrl)}`); return;
    }
    if (!isUserWhitelisted(req.user.username)) { res.status(403).send('Instance access denied.'); return; }
    const session = req.session as ConsentSession;
    session.mcpCsrf ||= secret();
    if (req.method === 'POST' && (req.body.csrf !== session.mcpCsrf || req.get('origin') !== oauth.config.origin)) {
      res.status(403).send('Invalid consent request. Reload this page and try again.'); return;
    }
    next();
  });
  const csrf = (req: Request): string => `<input type="hidden" name="csrf" value="${escape((req.session as ConsentSession).mcpCsrf)}">`;

  async function repositories(req: Request): Promise<string[]> {
    if (overrides.accessibleRepositories) return overrides.accessibleRepositories(req.user!);
    const github = new Octokit({ auth: req.user!.accessToken, request: { timeout: 10000 } });
    const { data } = await github.request('GET /user');
    if (String(data.id) !== req.user!.id) throw new Error('GitHub identity mismatch');
    const configured = (await loadMonitoredReposRaw()).filter(repo => repo.enabled);
    const allowed: string[] = [];
    for (const repo of configured.slice(0, 100)) {
      const [owner, name] = repo.name.split('/');
      try { await github.request('GET /repos/{owner}/{repo}', { owner, repo: name }); allowed.push(repo.name); } catch { /* inaccessible repositories are not offered */ }
    }
    return allowed;
  }

  app.get('/mcp/consent', async (req, res) => {
    const id = typeof req.query.request === 'string' ? req.query.request : '';
    const pending = await oauth.store.get<PendingAuthorization>('pending', digest(id));
    if (!pending) { res.status(400).send(renderMcpPage('Request expired', '<p>Return to your chat client and connect again.</p>')); return; }
    const repos = await repositories(req);
    res.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(pending.params.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`);
    res.type('html').send(renderMcpPage('Connect an app', `<p><strong>${escape(pending.client.client_name || pending.client.client_id)}</strong> wants access to this ProPR instance as <strong>${escape(req.user!.username)}</strong>.</p><p>Instance: ${escape(oauth.config.instanceId)}</p><p>Choose permissions below. Read is required; leave optional permissions unchecked for read-only access. Execute can start work; publish creates GitHub issues; merge can merge reviewed changes; manage changes instance configuration.</p><p>Choose repositories. Access always remains limited by your current permissions. You can revoke this connection at any time.</p><form method="post">${csrf(req)}<input type="hidden" name="request" value="${escape(id)}"><h2>Permissions</h2>${pending.params.scopes?.map(scope => `<label><input type="checkbox" name="scopes" value="${escape(scope)}"${scope === 'read' ? ' checked disabled' : ''}>${escape(scope)}${scope === 'read' ? ' (required)' : ''}</label>`).join('')}<input type="hidden" name="scopes" value="read"><h2>Repositories</h2>${repos.map(repo => `<label><input type="checkbox" name="repositories" value="${escape(repo)}">${escape(repo)}</label>`).join('')}<p><small>Return address: ${escape(pending.params.redirectUri)}</small></p><button name="decision" value="approve">Allow selected access</button><button class="secondary" name="decision" value="deny">Deny</button></form>`));
  });

  app.post('/mcp/consent', async (req, res) => {
    if (typeof req.body.request !== 'string') { res.status(400).send('Invalid request'); return; }
    if (!['approve', 'deny'].includes(req.body.decision)) { res.status(400).send('Choose allow or deny.'); return; }
    if (req.body.decision === 'deny') {
      const pending = await oauth.store.db.transaction(tx => oauth.store.take<PendingAuthorization>('pending', digest(req.body.request), tx));
      if (!pending) { res.status(400).send('Request expired'); return; }
      const url = new URL(pending.params.redirectUri); url.searchParams.set('error', 'access_denied');
      url.searchParams.set('iss', `${oauth.config.origin}/`);
      if (pending.params.state) url.searchParams.set('state', pending.params.state);
      res.set('Content-Security-Policy', `default-src 'none'; form-action 'self' ${url.origin}; frame-ancestors 'none'; base-uri 'none'`);
      res.redirect(url.href); return;
    }
    const selected = Array.isArray(req.body.repositories) ? req.body.repositories : [req.body.repositories].filter(Boolean);
    const allowed = await repositories(req);
    if (!selected.length || selected.some((repo: unknown) => typeof repo !== 'string' || !allowed.includes(repo))) { res.status(400).send('Select at least one accessible repository.'); return; }
    const authorization = await resolveInstanceAuthorization(req.user!, oauth.store.db);
    const selectedScopes = typeof req.body.scopes === 'string' ? [req.body.scopes] : req.body.scopes ?? [];
    let redirect: string;
    try { redirect = await oauth.approve(req.body.request, req.user!, [...new Set(selected)] as string[], { membershipSource: authorization.source, selectedScopes }); }
    catch { res.status(400).send('Request expired or invalid permission selection. Select only requested permissions, including read.'); return; }
    res.set('Content-Security-Policy', `default-src 'none'; form-action 'self' ${new URL(redirect).origin}; frame-ancestors 'none'; base-uri 'none'`);
    res.redirect(redirect);
  });

  app.get('/mcp/apps', async (req, res) => {
    const cursor = typeof req.query.after === 'string' ? req.query.after : '';
    const rows = await oauth.store.db('mcp_records').where({ kind: 'grant', owner_id: req.user!.id }).where('id', '>', cursor).orderBy('id').limit(51).select('id', 'value');
    const next = rows.length > 50 ? rows[49].id : null;
    rows.splice(50);
    const grants = rows.map(row => oauth.store.unseal<McpGrant>(row.value)).filter(grant => grant.ownerId === req.user!.id && !grant.revoked && grant.expiresAt > Date.now());
    res.type('html').send(renderMcpPage('Your connected apps', `<p>These apps can act with your ProPR permissions. Revoking an app immediately invalidates its access and refresh tokens.</p>${grants.length ? grants.map(grant => `<article><h2>${escape(grant.clientName)}</h2><p>${escape(grant.scopes.join(', '))}</p><p>${escape(grant.repositories.join(', '))}</p><form method="post" action="/mcp/apps/revoke">${csrf(req)}<input type="hidden" name="grant" value="${escape(grant.id)}"><button class="secondary">Revoke access</button></form></article>`).join('') : '<p>No connected apps.</p>'}${next ? `<p><a href="/mcp/apps?after=${encodeURIComponent(next)}">Next page</a></p>` : ''}`));
  });
  app.post('/mcp/apps/revoke', async (req: Request, res: Response) => {
    if (typeof req.body.grant === 'string') await oauth.revokeGrant(req.body.grant, req.user!.id);
    res.redirect('/mcp/apps');
  });
  app.get('/mcp/artifacts/:id', async (req, res) => {
    const artifact = await oauth.store.get<Artifact>('artifact', req.params.id);
    if (!artifact || artifact.ownerId !== req.user!.id || !(await repositories(req)).includes(artifact.repository)) { res.status(404).send('Artifact not found'); return; }
    const goal = artifact.parentKind === 'goal';
    if (!await oauth.store.db(goal ? 'goals' : 'task_drafts').where({ [goal ? 'goal_id' : 'draft_id']: artifact.parentId, [goal ? 'owner_id' : 'user_id']: req.user!.id }).first()) { res.status(404).send('Artifact parent not found'); return; }
    res.set({ 'Content-Type': artifact.mimeType, 'Content-Disposition': `attachment; filename="${artifact.filename}"`, 'X-Content-Type-Options': 'nosniff' }).send(Buffer.from(artifact.data, 'base64'));
  });
}
