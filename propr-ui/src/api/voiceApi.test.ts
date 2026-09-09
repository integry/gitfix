import { voiceBriefingResponseSchema } from '@propr/shared';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getVoiceBriefing, getVoiceCapabilities } from './voiceApi';

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
  afterEach(() => vi.restoreAllMocks());

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
