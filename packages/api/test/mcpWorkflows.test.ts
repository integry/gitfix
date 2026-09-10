import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpPrincipal } from '../mcp/policy.js';
import type { ToolDeps } from '../mcp/tools.js';

test('both SDK eras drive persisted goal, TODO, notification, settings and guarded PR workflows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'propr-mcp-workflows-'));
  process.env.DATA_DIR = root;
  process.env.DB_FILENAME = path.join(root, 'propr.sqlite');
  process.env.NODE_ENV = 'test';
  const core = await import('@propr/core');
  const issueJobs: Array<{ name: string; data: Record<string, unknown> }> = [];
  const issueQueue = { add: async (name: string, data: Record<string, unknown>) => { issueJobs.push({ name, data }); return { id: String(issueJobs.length) }; } };
  const cacheReads: string[] = [];
  let githubBoundary: unknown;
  // Only outbound GitHub and queue boundaries are fixtures. Catalog, handlers,
  // label orchestration, authorization and persistence remain the real code.
  const boundary = await mock.module('@propr/core', { namedExports: { ...core,
    getAuthenticatedOctokit: async () => githubBoundary,
    getIssueQueue: async () => issueQueue, issueQueue,
    getStoredFileChanges: async (taskId: string) => { cacheReads.push(taskId); return { taskId, lastUpdated: new Date().toISOString(), files: [{ path: 'src/retry.ts', linesAdded: 1, linesRemoved: 0, status: 'modified', diff: '+Handle transient failures\n' }] }; },
  } });
  const { McpStore } = await import('../mcp/store.js');
  const { McpOAuthProvider } = await import('../mcp/oauth.js');
  const { McpPolicy } = await import('../mcp/policy.js');
  const { createToolCatalog } = await import('../mcp/tools.js');
  const { buildMcpServer } = await import('../mcp/server.js');
  const { db } = core;
  let server: ReturnType<typeof createServer> | undefined;
  const attachmentDirectories: string[] = [];
  const registry = core.AgentRegistry.getInstance();
  const agent = { config: { id: 'fixture-agent', alias: 'claude', type: 'claude', enabled: true, supportedModels: ['fixture-model'], defaultModel: 'fixture-model' } };
  const stubs = [mock.method(registry, 'ensureInitialized', async () => {}), mock.method(registry, 'getAgentById', () => agent as never), mock.method(registry, 'getAgentByAlias', () => agent as never)];
  try {
    await core.runMigrations();
    await core.saveAgents([agent.config as never]);
    await core.saveSettings({ default_agent_alias: 'claude' });
    await core.saveMonitoredRepos([{ id: randomUUID(), name: 'acme/repo', enabled: true, baseBranch: 'main' }]);
    const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'fixture-instance', encryptionKey: randomBytes(32) };
    const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
    let head = 'a'.repeat(40), checks = 'SUCCESS', mergeState = 'CLEAN', merged = false;
    const comments: string[] = [];
    const issues: Array<{ number: number; title: string; labels: string[] }> = [];
    const github = {
      request: async (route: string, args: Record<string, unknown>) => {
        if (route === 'POST /repos/{owner}/{repo}/issues') { const issue = { number: issues.length + 1, title: String(args.title), labels: args.labels as string[] }; issues.push(issue); return { data: { ...issue, html_url: `https://github.com/acme/repo/issues/${issue.number}` } }; }
        if (route.includes('/labels')) {
          const issue = issues.find(issue => issue.number === args.issue_number)!;
          if (route.startsWith('DELETE')) issue.labels = issue.labels.filter(label => label !== args.name);
          else issue.labels.push(...args.labels as string[]);
          return { data: issue.labels };
        }
        if (route === 'GET /repos/{owner}/{repo}') return { data: { permissions: { push: true } } };
        if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: { number: args.pull_number, title: 'Fixture PR', body: 'Improve reliability', state: 'open', draft: false, merged, head: { sha: head }, base: { ref: 'main' }, html_url: 'https://github.com/acme/repo/pull/42' } };
        if (route.endsWith('/reviews')) return { data: [{ id: 1, state: 'APPROVED', body: 'Reviewed', commit_id: head }] };
        if (route.endsWith('/check-runs')) return { data: { check_runs: [{ name: 'tests', status: 'completed', conclusion: checks.toLowerCase() }] } };
        if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') { comments.push(String(args.body)); return { data: { id: comments.length, html_url: 'https://github.com/acme/repo/pull/42#issuecomment-1' } }; }
        if (route.endsWith('/update-branch')) { assert.equal(args.expected_head_sha, head); head = 'b'.repeat(40); return { data: { message: 'Updated branch', url: 'https://github.com/acme/repo/pull/42' } }; }
        if (route.endsWith('/merge')) { assert.equal(args.sha, head); assert.equal(checks, 'SUCCESS'); assert.equal(mergeState, 'CLEAN'); merged = true; return { data: { merged, sha: head } }; }
        throw new Error(`Unexpected GitHub fixture request: ${route}`);
      },
      graphql: async () => ({ repository: { pullRequest: { headRefOid: head, mergeStateStatus: mergeState, reviewDecision: 'APPROVED', commits: { nodes: [{ commit: { statusCheckRollup: { state: checks } } }] } } } }),
    };
    githubBoundary = github;
    const permissions = ['instance.manage_settings', 'instance.manage_agents', 'instance.manage_runtime', 'instance.manage_members'] as const;
    const scopes = ['read', 'plan', 'publish', 'execute', 'review', 'merge', 'manage'] as const;
    const principal = { user: { id: '123', username: 'fixture-user', login: 'fixture-user', displayName: 'Fixture user', email: null, avatarUrl: null, accessToken: 'fixture-github' }, authorization: { role: 'admin', source: 'local', permissions: [...permissions] },
      scopes: [...scopes], github, grant: { id: 'workflow-grant', ownerId: '123', clientId: 'fixture-client', clientName: 'Fixture', instanceId: config.instanceId, resource: config.resource, scopes: [...scopes], repositories: ['acme/repo'], createdAt: Date.now(), expiresAt: Date.now() + 60000, revoked: false, membershipSource: 'local' } } as McpPrincipal;
    const jobs: Array<Record<string, unknown>> = [];
    const deps: ToolDeps = { db, policy, taskQueue: { add: async (_name: string, data: Record<string, unknown>) => { jobs.push(data); return { id: String(jobs.length) }; }, getJobs: async () => [] } as never,
      redisClient: { get: async () => null, del: async () => 1, publish: async () => 1, set: async () => 'OK', eval: async () => 1 } as never, runtimeBuildQueue: {} as never,
      goalServices: { generateTitle: async () => 'Fixture goal', loadVisualPreviewSettings: async () => ({ enabled: false, types: ['image'] }), getOctokit: async () => github as never,
        stopExecution: async () => ({ success: true, containerStopped: true, removedQueuedJobs: 1 }) as never,
        getCapabilities: async () => [{ agentId: agent.config.id, agentAlias: 'claude', agentType: 'claude', goalCapable: true, lifecycle: { launch: 'goal-prompt', resume: 'whole-session', runningInput: 'safe-boundary-resume' }, controls: { liveInput: false, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true } }] } };
    const catalog = createToolCatalog(deps);
    const app = express(); app.use(express.json());
    app.all('/api/mcp', async (req, res) => {
      const handler = createMcpHandler(() => buildMcpServer(principal, deps, catalog), { legacy: 'stateless' });
      try { await toNodeHandler(handler)(req, res, req.body); } finally { await handler.close(); }
    });
    server = createServer(app); await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`);
    for (const modern of [true, false]) {
      head = 'a'.repeat(40); merged = false;
      const client = modern ? new Client({ name: 'workflow-modern', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } }) : new LegacyClient({ name: 'workflow-legacy', version: '1' });
      await client.connect((modern ? new StreamableHTTPClientTransport(url) : new LegacyTransport(url)) as never);
      let sequence = 0;
      const call = async (name: string, args: Record<string, unknown>, mutation = false) => {
        const result = await client.callTool({ name, arguments: { ...args, ...(mutation ? { idempotencyKey: `workflow-${modern}-${sequence++}` } : {}) } });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return (result.structuredContent as { data: Record<string, any> }).data; // eslint-disable-line @typescript-eslint/no-explicit-any
      };
      try {
        const repository = 'acme/repo';
        const plan = await call('create_plan', { repository, name: 'Reliability', prompt: 'Improve reliability', plan: [{ title: 'Handle failures', body: 'Persist results', implementation: 'Use the state machine' }] }, true);
        const planId = plan.result.planId;
        attachmentDirectories.push(path.join(process.cwd(), 'storage', 'drafts', planId));
        const upload = await call('upload_attachment', { repository, parentKind: 'plan', parentId: planId, filename: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('Bounded fixture context').toString('base64') }, true);
        assert.equal(upload.state, 'completed', JSON.stringify(upload));
        const artifact = await call('get_artifact', { artifactId: upload.result.artifactId, length: 8 }); assert.equal(Buffer.from(artifact.data, 'base64').toString(), 'Bounded '); assert.equal(artifact.nextOffset, 8);
        const draft = await call('get_plan', { repository, planId });
        const attachment = await call('get_attachment', { repository, parentKind: 'plan', parentId: planId, attachmentId: draft.attachments[0].id });
        assert.equal(Buffer.from(attachment.data, 'base64').toString(), 'Bounded fixture context');
        assert.ok(!JSON.stringify(draft).includes('storedPath'));
        const publication = await call('publish_plan', { repository, planId, expectedRevision: draft.mcp_revision }, true); assert.equal(publication.state, 'completed');
        const issueNumber = publication.result.issues[0].number;
        issues.find(issue => issue.number === issueNumber)!.labels.push('auto-merge');
        const implementation = { repository, planId, issues: [issueNumber], models: [{ agent_alias: 'claude', model_name: 'fixture-model' }], autoMerge: false };
        const starts = await Promise.all([call('implement_plan', implementation, true), call('implement_plan', implementation, true)]);
        assert.equal(starts.filter(result => result.state === 'accepted').length, 1, JSON.stringify(starts));
        assert.equal((await db('plan_issues').where({ draft_id: planId, issue_number: issueNumber }).first()).status, 'processing');
        assert.equal(issueJobs.filter(job => job.name === 'processGitHubIssue' && job.data.number === issueNumber).length, 1);
        assert.ok(!issues.find(issue => issue.number === issueNumber)!.labels.includes('auto-merge'));
        // Worker boundary: a queued job creates the task; read/followup then use
        // the real handlers against its persisted row and history.
        const taskId = `issue-fixture-implementation-${modern}`;
        await db('tasks').insert({ task_id: taskId, repository, issue_number: issueNumber, task_type: 'issue' });
        await db('task_history').insert({ task_id: taskId, state: 'completed' });
        const changes = await call('get_task_changes', { repository, taskId, detail: 'diff', path: 'src/retry.ts' });
        assert.equal(changes.files[0].diff, '+Handle transient failures\n'); assert.equal(cacheReads.at(-1), taskId);
        const followup = await call('send_task_followup', { repository, taskId, message: 'Please cover transient errors' }, true); assert.equal(followup.state, 'completed', JSON.stringify(followup));
        assert.ok(issueJobs.some(job => job.name === 'processPullRequestComment'));
        const created = await call('create_goal', { repository, objective: 'Improve reliability', agentId: agent.config.id, model: 'fixture-model', launchStrategy: 'direct' }, true);
        assert.equal(created.state, 'accepted', JSON.stringify(created));
        const goalId = created.result.continuation.goalId;
        assert.equal((await db('goals').where({ goal_id: goalId }).first()).desired_state, 'running');
        assert.ok(jobs.some(job => job.goalId === goalId));
        const input = await call('send_goal_input', { repository, goalId, message: 'Add error handling' }, true); assert.equal(input.state, 'completed', JSON.stringify(input));
        assert.ok(await db('goal_inputs').where({ goal_id: goalId, message: 'Add error handling' }).first());
        await call('pause_goal', { repository, goalId }, true); assert.equal((await db('goals').where({ goal_id: goalId }).first()).desired_state, 'paused');
        const resume = await call('resume_goal', { repository, goalId }, true); assert.equal(resume.state, 'completed', JSON.stringify(resume));
        assert.equal((await db('goals').where({ goal_id: goalId }).first()).desired_state, 'running');
        const cancel = await call('cancel_goal', { repository, goalId }, true); assert.equal(cancel.state, 'accepted');
        assert.equal((await db('goals').where({ goal_id: goalId }).first()).desired_state, 'cancelled');
        const category = await call('create_todo_category', { repository, name: 'Reliability' }, true); assert.equal(category.state, 'completed', JSON.stringify(category));
        const todo = await call('create_todo', { repository, content: 'Handle transient errors' }, true); assert.equal(todo.state, 'completed', JSON.stringify(todo));
        const todoId = todo.result.todoId, categoryId = category.result.categoryId;
        await call('move_todo', { repository, todoId, categoryId }, true);
        await call('update_todo', { repository, todoId, isCompleted: true }, true);
        assert.equal((await db('repo_todos').where({ todo_id: todoId }).first()).is_completed, 1);
        const deletion = { repository, todoId, idempotencyKey: `delete-todo-${modern}` };
        const deleted = await call('delete_todo', deletion); assert.equal(deleted.state, 'completed');
        assert.equal((await call('delete_todo', deletion)).operationId, deleted.operationId);
        const event = await core.createNotificationEvent({ kind: 'task', deduplicationKey: `fixture-event-${modern}`, title: 'Task complete', body: 'Ready for review', target: { type: 'task', repository, taskId: `fixture-task-${modern}` }, recipients: ['123'] });
        const notifications = await call('list_notifications', { repository }); assert.ok(notifications.notifications.some((item: { id: string }) => item.id === event.id));
        await call('mark_notification_read', { repository, notificationId: event.id }, true);
        await call('dismiss_notification', { repository, notificationId: event.id }, true);
        assert.ok(!(await call('list_notifications', { repository })).notifications.some((item: { id: string }) => item.id === event.id));
        const settings = await call('update_execution_settings', { settings: { ultrafix_max_cycles: 3 } }, true); assert.equal(settings.state, 'completed', JSON.stringify(settings));
        assert.equal((await call('get_execution_settings', {})).ultrafix_max_cycles, 3);
        await call('update_repository_preferences', { repository, starred: true }, true);
        assert.equal((await call('get_repository_preferences', { repository })).preferences.starred, true);
        assert.equal((await call('resolve_reference', { kind: 'repository', query: 'acme/repo' })).match, 'exact');
        const pr = { repository, pullRequest: 42, expectedHead: head };
        for (const name of ['review_pull_request', 'fix_review_findings', 'run_ultrafix']) assert.equal((await call(name, pr, true)).state, 'accepted');
        assert.ok(comments.some(comment => comment.startsWith('/ultrafix goal=9 max=3')));
        checks = 'FAILURE'; assert.equal((await call('merge_pull_request', pr, true)).result.error.code, 'CHECKS_NOT_PASSED'); assert.equal(merged, false);
        checks = 'SUCCESS'; mergeState = 'BLOCKED'; assert.equal((await call('merge_pull_request', pr, true)).result.error.code, 'CHECKS_NOT_PASSED'); assert.equal(merged, false);
        mergeState = 'CLEAN'; await call('update_pull_request_branch', pr, true); assert.equal(merged, false);
        assert.equal((await call('merge_pull_request', pr, true)).result.error.code, 'STALE_HEAD');
        assert.equal((await call('merge_pull_request', { ...pr, expectedHead: head }, true)).state, 'completed'); assert.equal(merged, true);
      } finally { await client.close(); }
    }
  } finally {
    stubs.forEach(stub => stub.mock.restore());
    boundary.restore();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await Promise.all(attachmentDirectories.map(directory => rm(directory, { recursive: true, force: true })));
    await core.closeConnection(); await rm(root, { recursive: true, force: true });
  }
});
