import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { FlatRequest } from '../requestTypes.js';
import { createExecutionRoutes } from '../routes/executionRoutes.js';
import { db } from '@propr/core';
after(() => db.destroy());

test('execution API redacts old persisted preview paths in prompts, log metadata, and downloads', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'preview-log-redaction-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = '/tmp/work tree/.propr/previews/screen.png';
  const message = `Captured "${local}" successfully`;
  const conversation = path.join(directory, 'conversation.json');
  const output = path.join(directory, 'output.txt');
  await writeFile(conversation, JSON.stringify([{ text: message }]));
  await writeFile(output, message);
  const redisClient = { get: async (key: string) => JSON.stringify(key.includes('prompt')
    ? { prompt: message } : { files: { conversation, stdout: output }, summary: message }) } as unknown as RedisClientType;
  const routes = createExecutionRoutes({ redisClient, db: {} as Knex });
  let body: unknown;
  const response = { status(code: number) { assert.equal(code, 200); return response; },
    json(value: unknown) { body = value; return response; }, send(value: unknown) { body = value; return response; },
    setHeader() { return response; } } as unknown as Response;
  const request = { params: { sessionId: 'session-2283' }, query: {} } as unknown as FlatRequest;
  for (const handler of [routes.getPrompt, routes.getLogs]) {
    await handler(request, response);
    assert.ok(!JSON.stringify(body).includes(local));
    assert.match(JSON.stringify(body), /successfully/);
  }
  for (const type of ['conversation', 'stdout']) {
    await routes.getLogByType({ ...request, params: { ...request.params, type } } as FlatRequest, response);
    assert.equal(typeof body, 'string');
    assert.ok(!String(body).includes(local));
    assert.match(String(body), /successfully/);
    if (type === 'conversation') assert.equal(JSON.parse(String(body)).length, 1, 'JSON remains parseable after redaction');
  }
  await writeFile(conversation, [JSON.stringify({ text: message }), JSON.stringify({ text: 'done' })].join('\n'));
  await routes.getLogByType({ ...request, params: { ...request.params, type: 'conversation' } } as FlatRequest, response);
  assert.ok(!String(body).includes(local));
  assert.equal(String(body).split('\n').map(line => JSON.parse(line)).length, 2, 'legacy JSONL remains valid');
});
