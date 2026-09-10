import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { pino } from 'pino';
import {
  PREVIEW_STORAGE_V1_DEFAULTS, parsePreviewStorageStatusV1, parsePreviewUploadV1,
  type PreviewStorageStatusV1,
} from '@propr/shared';
import { ManagedPreviewStorageClientV1, type PreviewStorageConnectContext } from '../src/services/previewStorage/v1.js';
import { createManagedPreviewStorageClient } from '../src/services/previewStorage/runtime.js';

const original = Buffer.from([0, 255, 42, 13, 10, 128]);
const input = { bytes: original, contentType: 'image/png', repository: 'integry/propr' };
const metadata = { sizeBytes: original.length, contentType: input.contentType, sha256: createHash('sha256').update(original).digest('hex') };
const secrets = ['relay-secret-value', 'viewer-secret-value', 'signed-secret-value', 'bearer-secret-value'];
const signedUrl = `https://objects.example.test/original?X-Amz-Signature=${secrets[2]}`;
const status: PreviewStorageStatusV1 = {
  version: 1, installationId: 42, enabled: true, ...PREVIEW_STORAGE_V1_DEFAULTS,
  usedBytes: 0, reservedBytes: 0, allowedContentTypes: ['image/png'], deleteSupported: true,
};
const upload = {
  version: 1, artifactId: 'artifact-1', objectKey: '42/original', ...metadata,
  put: { url: signedUrl, headers: { 'Content-Type': 'image/png', 'Content-Length': String(original.length) }, expiresAt: '2099-01-01T00:00:00Z' },
};
const artifact = { version: 1, artifactId: upload.artifactId, objectKey: upload.objectKey, state: 'ready', ...metadata };
function fixture(options: {
  context?: PreviewStorageConnectContext;
  status?: unknown;
  upload?: unknown;
  finalize?: unknown;
  failAt?: number;
  failure?: Response | Error;
} = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const context = options.context ?? { connected: true, connectAccount: { installationId: 42, hasPlusAccess: true } };
  const client = new ManagedPreviewStorageClientV1({
    routingUrl: 'wss://connect.example.test', relayToken: secrets[0], getConnectContext: async () => context,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === options.failAt) {
        if (options.failure instanceof Error) throw options.failure;
        return options.failure ?? new Response('Unavailable', { status: 503 });
      }
      if (String(url).endsWith('/status')) return Response.json(options.status ?? status);
      if (String(url).endsWith('/uploads')) return Response.json(options.upload ?? upload);
      if (init?.method === 'PUT' || init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json(options.finalize ?? artifact);
    },
  });
  return { client, calls, context };
}

test('status parser preserves server limits and strips unknown secret fields', () => {
  const effective = { ...status, quotaBytes: 40 * 1024 ** 3, maxObjectBytes: 250 * 1024 ** 2, retentionDays: 30 };
  assert.deepEqual(parsePreviewStorageStatusV1({ ...effective, viewerToken: secrets[1] }), effective);
  for (const invalid of [null, [], { ...status, version: 2 }, { ...status, enabled: 'true' },
    { ...status, usedBytes: -1 }, { ...status, quotaBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...status, maxObjectBytes: 0 }, { ...status, retentionDays: 1.5 }, { ...status, allowedContentTypes: ['text/html'] }]) {
    assert.equal(parsePreviewStorageStatusV1(invalid), undefined);
  }
});

for (const [name, context, state] of [
  ['Community', { connected: true, connectAccount: { installationId: 42, hasPlusAccess: false } }, 'plus_required'],
  ['offline Plus', { connected: false, connectAccount: { installationId: 42, hasPlusAccess: true } }, 'unavailable'],
  ['missing account_status', { connected: true }, 'unavailable'],
] as const) {
  test(`${name} never contacts managed storage`, async () => {
    const { client, calls } = fixture({ context });
    assert.equal((await client.getStatus()).state, state);
    assert.deepEqual(await client.uploadOriginal(input), { stored: false, code: state });
    assert.equal(calls.length, 0);
  });
}

test('server disabled, unavailable, mismatched installation and v2 statuses fail closed', async () => {
  for (const options of [{ status: { ...status, enabled: false } }, { failAt: 1 },
    { status: { ...status, installationId: 99 } }, { status: { ...status, version: 2 } }]) {
    const { client, calls } = fixture(options);
    assert.equal((await client.uploadOriginal(input)).stored, false);
    assert.equal(calls.length, 1);
  }
});

test('Plus uploads the exact original and finalizes the bound object without forwarding relay credentials', async () => {
  const { client, calls } = fixture({ finalize: { ...artifact, viewerToken: secrets[1] } });
  assert.deepEqual(await client.uploadOriginal(input), { stored: true, artifact });
  assert.deepEqual(calls.map(call => call.init?.method), ['GET', 'POST', 'PUT', 'POST']);
  assert.equal(calls[2].url, signedUrl);
  assert.deepEqual(calls[2].init?.body, original);
  assert.deepEqual(JSON.parse(calls[1].init?.body as string), { version: 1, repository: 'integry/propr', ...metadata });
  assert.deepEqual(JSON.parse(calls[3].init?.body as string), { version: 1, objectKey: upload.objectKey, ...metadata });
  assert.equal(new Headers(calls[2].init?.headers).get('authorization'), null);
  assert.equal(new Headers(calls[1].init?.headers).get('authorization'), `Bearer ${secrets[0]}`);
  assert.ok(calls.every(call => call.init?.redirect === 'error'));
});

test('entitlement is rechecked on every upload', async () => {
  const { client, calls, context } = fixture();
  assert.equal((await client.getStatus()).enabled, true);
  context.connectAccount!.hasPlusAccess = false;
  assert.deepEqual(await client.uploadOriginal(input), { stored: false, code: 'plus_required' });
  assert.equal(calls.length, 1);
});

for (const [override, code] of [
  [{ maxObjectBytes: 5 }, 'object_too_large'],
  [{ quotaBytes: 10, usedBytes: 3, reservedBytes: 2 }, 'quota_exceeded'],
  [{ allowedContentTypes: ['video/mp4'] }, 'content_type_not_allowed'],
] as const) {
  test(`server effective constraints prevent upload: ${code}`, async () => {
    const { client, calls } = fixture({ status: { ...status, ...override } });
    assert.deepEqual(await client.uploadOriginal(input), { stored: false, code });
    assert.equal(calls.length, 1);
  });
}

for (const [httpStatus, code] of [[409, 'quota_exceeded'], [413, 'object_too_large']] as const) {
  test(`relay ${code} remains a safe typed error`, async () => {
    const { client, calls } = fixture({ failAt: 2, failure: Response.json({ code, message: secrets.join(' ') }, { status: httpStatus }) });
    assert.deepEqual(await client.uploadOriginal(input), { stored: false, code });
    assert.equal(calls.length, 2);
  });
}

test('mismatched metadata, expired grants and unsafe signed headers prevent PUT', async () => {
  for (const value of [
    { ...upload, sizeBytes: 20 }, { ...upload, sha256: 'a'.repeat(64) },
    { ...upload, put: { ...upload.put, expiresAt: '2000-01-01T00:00:00Z' } },
    { ...upload, put: { ...upload.put, url: 'http://objects.example.test/file' } },
    { ...upload, put: { ...upload.put, headers: { ...upload.put.headers, Authorization: `Bearer ${secrets[3]}` } } },
    { ...upload, put: { ...upload.put, headers: { 'Content-Type': 'video/mp4' } } },
  ]) {
    const { client, calls } = fixture({ upload: value });
    assert.equal((await client.uploadOriginal(input)).stored, false);
    assert.equal(calls.length, 2);
  }
  assert.equal(parsePreviewUploadV1({ ...upload, artifactId: '../status' }), undefined);
});

test('failed PUT is never finalized and a mismatched finalize is never accepted', async () => {
  const failedPut = fixture({ failAt: 3 });
  assert.deepEqual(await failedPut.client.uploadOriginal(input), { stored: false, code: 'upload_failed' });
  assert.equal(failedPut.calls.length, 3);
  const badFinalize = fixture({ finalize: { ...artifact, objectKey: 'different' } });
  assert.deepEqual(await badFinalize.client.uploadOriginal(input), { stored: false, code: 'object_mismatch' });
});

test('raw transport errors and malicious response bodies never enter logs or returned errors', async () => {
  let output = '';
  const log = pino({}, { write(chunk) { output += chunk; } });
  for (const failAt of [1, 2, 3, 4]) {
    for (const failure of [new Error(`${signedUrl} ${secrets.join(' ')}`),
      Response.json({ code: secrets[0], message: secrets.join(' '), url: signedUrl }, { status: 500 })]) {
      const { client } = fixture({ failAt, failure });
      const result = await client.uploadOriginal(input);
      log.warn({ result }, 'Storage attempt');
      output += inspect(result);
    }
  }
  const deletion = fixture({ failAt: 2, failure: new Error(secrets.join(' ')) });
  await assert.rejects(deletion.client.deleteArtifact('artifact-1'), error => {
    log.error({ err: error }, 'Delete attempt');
    output += inspect(error);
    return true;
  });
  for (const secret of [...secrets, signedUrl]) assert.ok(!output.includes(secret));
});

test('delete only uses the versioned endpoint when advertised', async () => {
  const enabled = fixture();
  await enabled.client.deleteArtifact('artifact-1');
  assert.equal(enabled.calls[1].url, 'https://connect.example.test/v1/preview-artifacts/artifact-1');
  assert.equal(enabled.calls[1].init?.method, 'DELETE');
  const disabled = fixture({ status: { ...status, deleteSupported: false } });
  await assert.rejects(disabled.client.deleteArtifact('artifact-1'), /delete_unsupported/);
  assert.equal(disabled.calls.length, 1);
});

test('runtime consumes the existing validated account_status and configured installation', async () => {
  const account = {
    installationId: 42, accountLogin: 'example', plan: 'plus', hasPlusAccess: true,
    activeSeats: 1, allowedSeats: 2, seatsRemaining: 1,
    billingCycleResetAt: '2026-10-01T00:00:00Z', sentAt: '2026-09-10T21:00:00Z',
  };
  let snapshot: unknown = { connected: true, connectAccount: account };
  let calls = 0;
  const env = { PROPR_GH_RELAY_TOKEN: secrets[0], GH_INSTALLATION_ID: '42' };
  const client = createManagedPreviewStorageClient(async () => JSON.stringify(snapshot), env,
    async () => { calls++; return Response.json(status); });
  assert.equal((await client.getStatus()).enabled, true);
  for (const value of [null, {}, { connected: false, connectAccount: account },
    { connected: true, connectAccount: { ...account, installationId: 99 } },
    { connected: true, connectAccount: { ...account, hasPlusAccess: 'true' } }]) {
    snapshot = value;
    assert.equal((await client.getStatus()).enabled, false);
  }
  assert.equal(calls, 1);
  const offline = createManagedPreviewStorageClient(async () => { throw new Error(secrets[0]); }, env);
  assert.equal((await offline.getStatus()).state, 'unavailable');
});
