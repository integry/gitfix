import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import knex from 'knex';
import { closeConnection } from '@propr/core';
import { up as initial } from '../../core/src/db/migrations/20251216000000_initial_sqlite_schema.js';
import { up as planIssues } from '../../core/src/db/migrations/20260120000000_add_plan_issues.js';
import { up as mcpMigration } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { McpStore } from '../mcp/store.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { McpError } from '../mcp/config.js';
import { McpPolicy, type McpPrincipal } from '../mcp/policy.js';
import { buildMcpServer } from '../mcp/server.js';
import { createToolCatalog, executeTool, type ToolDeps } from '../mcp/tools.js';

after(async () => closeConnection());

test('both official SDK protocol eras execute real draft/revision/publication/task transitions over the same HTTP endpoint', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await initial(db); await planIssues(db); await mcpMigration(db);
  await db.schema.alterTable('task_drafts', table => table.boolean('paused').defaultTo(false));
  await db.schema.createTable('goals', table => { table.string('goal_id'); table.string('owner_id'); table.string('current_task_id'); });
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'test-instance', encryptionKey: randomBytes(32) };
  const oauth = new McpOAuthProvider(new McpStore(db, config.encryptionKey), config);
  const policy = new McpPolicy(oauth, config);
  let authorized = true;
  policy.repository = async (_principal, repository) => { if (!authorized || repository !== 'acme/repo') throw new McpError('REPOSITORY_FORBIDDEN', 'Denied', 403); };
  const githubIssues: Array<Record<string, unknown>> = [];
  const principal: McpPrincipal = { user: { id: '123', login: 'tester', username: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'fixture-github-credential' }, authorization: { role: 'member', permissions: [], source: 'local' },
    grant: { id: 'grant-1', ownerId: '123', clientId: 'client-1', clientName: 'Test', instanceId: config.instanceId, resource: config.resource, scopes: ['read', 'plan', 'publish', 'execute'], repositories: ['acme/repo'], createdAt: Date.now(), expiresAt: Date.now() + 60000, revoked: false, membershipSource: 'local' }, scopes: ['read', 'plan', 'publish', 'execute'],
    github: { request: async (route: string, payload: Record<string, unknown>) => {
      assert.equal(route, 'POST /repos/{owner}/{repo}/issues');
      githubIssues.push(payload); return { data: { number: githubIssues.length, title: payload.title, html_url: `https://github.com/acme/repo/issues/${githubIssues.length}` } };
    } } as never };
  const deps: ToolDeps = { db, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
  const catalog = createToolCatalog(deps);
  const app = express(); app.use(express.json());
  const wire: Array<{ method: string; version?: string }> = [];
  app.all('/api/mcp', async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-mcp-access') { res.status(401).end(); return; }
    wire.push({ method: req.body?.method, version: req.get('mcp-protocol-version') });
    res.set('Cache-Control', 'no-store');
    const handler = createMcpHandler(() => buildMcpServer(principal, deps, catalog), { legacy: 'stateless' });
    try { await toNodeHandler(handler)(req, res, req.body); } finally { await handler.close(); }
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`);
  try {
    for (const modern of [true, false]) {
      const client = modern ? new Client({ name: 'test-modern', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } }) : new LegacyClient({ name: 'test-legacy', version: '1' });
      const transport = modern ? new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer fixture-mcp-access' } } }) : new LegacyTransport(url, { requestInit: { headers: { Authorization: 'Bearer fixture-mcp-access' } } });
      await client.connect(transport as never);
      try {
        const inventory = await client.listTools();
        assert.ok(inventory.tools.some(tool => tool.name === 'create_plan'));
        assert.ok(!inventory.tools.some(tool => tool.name === 'merge_pull_request'));
        const resources = await client.listResources(); assert.equal(resources.resources.length, 3);
        const promptList = await client.listPrompts(); assert.equal(promptList.prompts.length, 7);
        const prompt = await client.getPrompt({ name: 'plan_change', arguments: { request: 'Improve reliability' } }); assert.equal(prompt.messages.length, 1);
        assert.equal((await db('task_drafts').count('* as count').first())!.count, modern ? 0 : 1);
        const call = async (name: string, args: Record<string, unknown>) => {
          const result = await client.callTool({ name, arguments: args });
          assert.notEqual(result.isError, true, JSON.stringify(result));
          return result.structuredContent as { data: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
        };
        const args = { repository: 'acme/repo', name: `Reliability ${modern}`, prompt: 'Improve reliability', idempotencyKey: `create-plan-${modern}`, plan: [{ title: 'Handle failures', body: 'Persist results', implementation: 'Use the existing state machine' }] };
        const create = await call('create_plan', args);
        assert.equal(create.data.state, 'completed');
        const id = create.data.result.planId;
        const duplicate = await call('create_plan', args); assert.equal(duplicate.data.operationId, create.data.operationId);
        const get = await call('get_plan', { repository: 'acme/repo', planId: id }); assert.equal(get.data.status, 'draft');
        const updated = await call('update_plan', { repository: 'acme/repo', planId: id, expectedRevision: 0, name: 'Reviewed reliability', idempotencyKey: `update-plan-${modern}` });
        assert.equal(updated.data.result.revision, 1);
        const stale = await call('update_plan', { repository: 'acme/repo', planId: id, expectedRevision: 0, name: 'Stale overwrite', idempotencyKey: `stale-plan-${modern}` });
        assert.equal(stale.data.state, 'failed'); assert.equal(stale.data.result.error.code, 'STALE_REVISION');
        const published = await call('publish_plan', { repository: 'acme/repo', planId: id, expectedRevision: 1, idempotencyKey: `publish-plan-${modern}` });
        assert.equal(published.data.state, 'completed');
        assert.equal((await db('task_drafts').where({ draft_id: id }).first()).status, 'executed');
        assert.equal((await db('plan_issues').where({ draft_id: id }).count('* as count').first())!.count, 1);
        const resource = await client.readResource({ uri: `propr://instances/test-instance/plans/${id}` }); assert.equal(resource.contents.length, 1);
        await db('tasks').insert({ task_id: `task-${modern}`, repository: 'acme/repo', task_type: 'issue', issue_number: 1 });
        await db('task_history').insert({ task_id: `task-${modern}`, state: 'processing' });
        let task = await call('get_task', { repository: 'acme/repo', taskId: `task-${modern}` }); assert.equal(task.data.latestEvent.state, 'processing');
        await db('task_history').insert({ task_id: `task-${modern}`, state: 'completed' });
        task = await call('get_task', { repository: 'acme/repo', taskId: `task-${modern}` }); assert.equal(task.data.latestEvent.state, 'completed');
        authorized = false;
        const denied = await client.callTool({ name: 'get_plan', arguments: { repository: 'acme/repo', planId: id } }); assert.equal(denied.isError, true);
        authorized = true;
        const crossUser = { ...principal, user: { ...principal.user, id: '999' } };
        await assert.rejects(executeTool(catalog.find(tool => tool.name === 'get_plan')!, { repository: 'acme/repo', planId: id }, crossUser, deps), /Target not found/);
      } finally { await client.close(); }
    }
    assert.ok(wire.some(item => item.method === 'server/discover' && item.version === '2026-07-28'));
    assert.ok(wire.some(item => item.method === 'initialize'));
    assert.ok(wire.some(item => item.method === 'tools/call' && item.version === '2025-11-25'));
    assert.equal(githubIssues.length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.destroy(); }
});
