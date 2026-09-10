import { voiceBriefingResponseSchema } from '@propr/shared';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getVoiceBriefing, getVoiceCapabilities } from './voiceApi';

const selectedBackend = vi.hoisted(() => ({ url: '' }));

vi.mock('./apiClient', async importOriginal => ({
  ...await importOriginal<typeof import('./apiClient')>(),
  // Model the epic desktop client's live API_BASE_URL export without replacing
  // its authenticated fetch/response behavior in these regressions.
  get API_BASE_URL() { return selectedBackend.url; },
}));

const capabilities = {
  mode: 'on_demand',
  serverAudio: false,
  persistentSession: false,
  rawAudioAccepted: false,
  transcriptStored: false,
} as const;

const briefing = voiceBriefingResponseSchema.parse({
  generatedAt: '2026-09-07T05:00:00.000Z',
  scope: 'attention',
  headline: 'One item needs attention.',
  speechText: 'One item needs attention.',
  counts: { running: 0, queued: 0, attention: 1, plans: 1, total: 1 },
  items: [{
    reference: 'plan 1',
    position: 1,
    kind: 'plan',
    id: 'plan-1',
    title: 'Plan for integry/propr',
    repository: 'integry/propr',
    status: 'review',
    summary: 'Plan for integry/propr is ready for review.',
    href: '/studio/plan-1',
    requiresAttention: true,
    actions: ['open', 'follow_up'],
    updatedAt: '2026-09-07T04:59:00.000Z',
  }],
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('voice API', () => {
  afterEach(() => {
    selectedBackend.url = '';
    vi.restoreAllMocks();
  });

  test('resolves the selected backend after import and again after a profile switch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(capabilities))
      .mockResolvedValueOnce(jsonResponse(briefing))
      .mockResolvedValueOnce(jsonResponse(capabilities))
      .mockResolvedValueOnce(jsonResponse(briefing));

    for (const url of ['http://127.0.0.1:3131', 'https://instance.example.test']) {
      selectedBackend.url = url;
      await getVoiceCapabilities();
      await getVoiceBriefing('attention');
    }

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:3131/api/voice/capabilities',
      'http://127.0.0.1:3131/api/voice/briefing?scope=attention',
      'https://instance.example.test/api/voice/capabilities',
      'https://instance.example.test/api/voice/briefing?scope=attention',
    ]);
  });

  test.each([404, 501])('identifies unavailable routes (HTTP %i) without using another backend', async status => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('Cannot GET /api/voice', { status }));

    for (const request of [getVoiceCapabilities, getVoiceBriefing]) {
      await expect(request()).rejects.toMatchObject({
        code: 'VOICE_ROUTES_UNAVAILABLE', status,
        message: expect.stringContaining('updating the desktop app alone is not enough'),
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('identifies a proxy/static-shell response instead of reporting a JSON parse error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>App shell</html>', {
      headers: { 'Content-Type': 'text/html' },
    }));
    await expect(getVoiceBriefing()).rejects.toMatchObject({
      code: 'VOICE_RESPONSE_NOT_JSON', status: 200,
    });
  });

  test('preserves authorization and server failures instead of treating them as absent routes', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Access denied' }), { status: 403 }))
      .mockResolvedValueOnce(new Response('private server detail', { status: 500 }));

    await expect(getVoiceBriefing()).rejects.toThrow('Access denied');
    await expect(getVoiceBriefing()).rejects.toThrow('The server ran into a problem (HTTP 500)');
  });

  test('preserves authenticated GET retry after token refresh', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'TOKEN_REFRESHED' }), { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(briefing));

    await expect(getVoiceBriefing('attention')).resolves.toEqual(briefing);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[1]);
  });

  test('uses only the fixed authenticated GET routes and validates both responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(capabilities))
      .mockResolvedValueOnce(jsonResponse(briefing));

    await expect(getVoiceCapabilities()).resolves.toEqual(capabilities);
    await expect(getVoiceBriefing('attention')).resolves.toEqual(briefing);

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/voice/capabilities', {
      method: 'GET',
      credentials: 'include',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/voice/briefing?scope=attention', {
      method: 'GET',
      credentials: 'include',
    });
  });

  test('rejects response drift through the shared schemas', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ...capabilities, serverAudio: true }))
      .mockResolvedValueOnce(jsonResponse({
        ...briefing,
        items: [{ ...briefing.items[0], href: 'https://example.test/plan-1' }],
      }));

    await expect(getVoiceCapabilities()).rejects.toThrow(/browser-audio capability contract/);
    await expect(getVoiceBriefing('attention')).rejects.toThrow(/item\.href/);
  });

  test('rejects an invalid scope before making a request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    expect(() => getVoiceBriefing('queued' as never)).toThrow(/voiceBriefing\.scope/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
