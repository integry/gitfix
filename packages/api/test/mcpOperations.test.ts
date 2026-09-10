import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knex from 'knex';
import { up } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { McpOperations } from '../mcp/operations.js';
import { McpError } from '../mcp/config.js';
import { parseClientMetadataDocument } from '../mcp/clients.js';

test('mutation deduplication survives concurrent callers and reopening the SQLite database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'propr-mcp-'));
  const config = { client: 'better-sqlite3', connection: { filename: path.join(root, 'test.sqlite') }, useNullAsDefault: true };
  let db = knex(config);
  try {
    await db.schema.createTable('task_drafts', table => { table.string('draft_id').primary(); table.string('name'); });
    await up(db);
    const principal = { user: { id: '123' }, grant: { id: 'grant-1' } } as never;
    const args = { idempotencyKey: 'durable-key-1', value: 'payload' };
    let invoked = 0;
    const operations = new McpOperations(db);
    const results = await Promise.all(Array.from({ length: 10 }, () => operations.run(principal, 'fixture_action', args, 'acme/repo', async () => { invoked++; return { status: 200, data: { changed: true } }; })));
    assert.equal(invoked, 1);
    assert.equal(new Set(results.map(result => result.operationId)).size, 1);
    await db.destroy(); db = knex(config);
    const restarted = new McpOperations(db);
    const result = await restarted.run(principal, 'fixture_action', args, 'acme/repo', async () => { throw new Error('Must not replay'); });
    assert.equal(result.state, 'completed'); assert.deepEqual(result.result, { changed: true });
    await assert.rejects(restarted.run(principal, 'fixture_action', { ...args, value: 'changed' }, 'acme/repo', async () => ({ status: 200, data: {} })), /different arguments/);
    await assert.rejects(restarted.get({ user: { id: '999' }, grant: { id: 'grant-1' } } as never, String(result.operationId)), /not found/);
    const uncertain = await restarted.run(principal, 'external_action', { idempotencyKey: 'uncertain-key-1' }, 'acme/repo', async () => { throw new Error('Network disconnected after possible side effect'); });
    assert.equal(uncertain.state, 'unknown');
    const rejected = await restarted.run(principal, 'guarded_action', { idempotencyKey: 'rejected-key-1' }, 'acme/repo', async () => { throw new McpError('STALE_HEAD', 'Head changed', 409); });
    assert.equal(rejected.state, 'failed');
    await db('task_drafts').insert({ draft_id: 'plan-1', name: 'Initial' });
    await db('task_drafts').where({ draft_id: 'plan-1' }).update({ name: 'Browser edit' });
    await db('task_drafts').where({ draft_id: 'plan-1' }).update({ name: 'Background edit' });
    assert.equal((await db('task_drafts').where({ draft_id: 'plan-1' }).first()).mcp_revision, 2);
  } finally { await db.destroy(); await rm(root, { recursive: true, force: true }); }
});

test('CIMD intersects plural supported methods with public PKCE instead of trusting a legacy preference', () => {
  const id = 'https://client.example/oauth/client.json';
  const document = { client_id: id, client_name: 'Test', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], token_endpoint_auth_method: 'private_key_jwt' };
  assert.equal(parseClientMetadataDocument(document, id).token_endpoint_auth_method, 'none');
  assert.equal(parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: undefined, token_endpoint_auth_method: undefined }, id).token_endpoint_auth_method, 'none');
  assert.equal(parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: ['private_key_jwt', 'none'] }, id).token_endpoint_auth_method, 'none');
  assert.throws(() => parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: ['private_key_jwt'] }, id));
  for (const supported of [[], ['none', 42], ['none', null], ['none', {}], ['none', ''], ['none', 'private key jwt'], 'none']) {
    assert.throws(() => parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: supported }, id));
  }
  for (const preference of [null, 42, {}, [], '', 'private key jwt']) {
    assert.throws(() => parseClientMetadataDocument({ ...document, token_endpoint_auth_method: preference }, id));
  }
  assert.equal(parseClientMetadataDocument({ ...document, token_endpoint_auth_method: undefined }, id).token_endpoint_auth_method, 'none');
  assert.equal(parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: undefined, token_endpoint_auth_method: 'none' }, id).token_endpoint_auth_method, 'none');
  assert.throws(() => parseClientMetadataDocument({ ...document, token_endpoint_auth_methods_supported: undefined }, id));
  assert.throws(() => parseClientMetadataDocument({ ...document, client_id: 'https://imposter.example/client.json' }, id));
});
