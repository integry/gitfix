import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PROPR_API_COMPATIBILITY, PROPR_UI_COMPATIBILITY } from '@propr/shared';
import { checkDesktopRuntimeCompatibility } from './desktopLocalSetup.js';

const image = `propr/app:${'a'.repeat(40)}@sha256:${'b'.repeat(64)}`;
const discovery = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  product: 'ProPR',
  version: '0.8.16',
  apiCompatibility: PROPR_API_COMPATIBILITY,
  uiCompatibility: PROPR_UI_COMPATIBILITY,
  desktopAuthentication: {
    protocolVersion: 2,
    browserPairing: true,
    instanceBearerTokens: true,
    socketIoBearerAuthentication: true,
  },
  canonicalEndpoint: null,
  publicInstanceIdentity: '123e4567-e89b-42d3-a456-426614174000',
  ...overrides,
});
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('desktop local runtime compatibility gate', () => {
  test('accepts only complete compatible desktop discovery', async () => {
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image,
      fetch: async () => response(discovery()),
    });
    assert.equal(result.compatible, true);
    assert.match(result.detail, new RegExp(PROPR_API_COMPATIBILITY));
  });

  test('rejects the legacy compatibility-only runtime before setup completion', async () => {
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image,
      fetch: async () => response({
        version: '0.8.15',
        apiCompatibility: '2026-06-27',
        uiCompatibility: '2026-06-27',
      }),
    });
    assert.equal(result.compatible, false);
    assert.match(result.detail, /discovery, identity, and desktop authentication contract/);
    assert.match(result.nextAction ?? '', /desktop:runtime:build/);
  });

  test('rejects a valid document when any secure transport capability is disabled', async () => {
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image,
      fetch: async () => response(discovery({ desktopAuthentication: {
        protocolVersion: 2,
        browserPairing: true,
        instanceBearerTokens: true,
        socketIoBearerAuthentication: false,
      } })),
    });
    assert.equal(result.compatible, false);
    assert.match(result.detail, /Socket.IO bearer authentication/);
  });

  test('rejects a truncated discovery response with a mismatched declared length', async () => {
    const body = JSON.stringify(discovery());
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image,
      fetch: async () => new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body) + 1),
        },
      }),
    });
    assert.equal(result.compatible, false);
    assert.match(result.detail, /response length is invalid/);
  });

  test('reports the selected app image and exact recovery contract for an old API', async () => {
    const result = await checkDesktopRuntimeCompatibility({
      baseUrl: 'http://127.0.0.1:14000', image,
      fetch: async () => response(discovery({
        apiCompatibility: '2025-01-01',
        uiCompatibility: '2025-01-01',
      })),
    });
    assert.equal(result.compatible, false);
    assert.match(result.detail, new RegExp(image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(result.nextAction ?? '', new RegExp(PROPR_API_COMPATIBILITY));
  });
});
