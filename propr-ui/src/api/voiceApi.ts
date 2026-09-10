import {
  parseVoiceBriefingScope,
  voiceBriefingResponseSchema,
  voiceCapabilitiesResponseSchema,
  type RuntimeVoiceSchema,
  type VoiceBriefingResponse,
  type VoiceBriefingScope,
  type VoiceCapabilitiesResponse,
} from '@propr/shared';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export class VoiceBackendError extends Error {
  readonly code: 'VOICE_ROUTES_UNAVAILABLE' | 'VOICE_RESPONSE_NOT_JSON';
  readonly status: number;

  constructor(code: VoiceBackendError['code'], status: number) {
    super(code === 'VOICE_ROUTES_UNAVAILABLE'
      ? `The selected backend does not expose voice briefings (HTTP ${status}). Check the selected instance and its /api/voice routes. A runtime that predates voice support needs to be updated; updating the desktop app alone is not enough.`
      : 'The voice request returned a web page or other non-JSON response. Check that the selected instance and proxy route /api/voice requests to the ProPR API.');
    this.name = 'VoiceBackendError';
    this.code = code;
    this.status = status;
  }
}

async function getValidatedJson<T>(
  path: string,
  schema: RuntimeVoiceSchema<T>,
): Promise<T> {
  // Desktop activation/profile switching updates this live binding. Do not
  // capture it at module load, before the selected backend is known.
  const response = await apiFetch(`${API_BASE_URL}/api/voice${path}`, {
    method: 'GET',
    credentials: 'include',
  });
  if (response.status === 404 || response.status === 501) {
    throw new VoiceBackendError('VOICE_ROUTES_UNAVAILABLE', response.status);
  }
  await handleApiResponse(response);
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new VoiceBackendError('VOICE_RESPONSE_NOT_JSON', response.status);
  }
  return schema.parse(await response.json() as unknown);
}

/** Fetch the fixed privacy and browser-audio capability contract. */
export function getVoiceCapabilities(): Promise<VoiceCapabilitiesResponse> {
  return getValidatedJson('/capabilities', voiceCapabilitiesResponseSchema);
}

/** Fetch one authenticated, server-built briefing snapshot. */
export function getVoiceBriefing(
  scope: VoiceBriefingScope = 'all',
): Promise<VoiceBriefingResponse> {
  // Keep even runtime JavaScript callers inside the shared closed scope set.
  const validatedScope = parseVoiceBriefingScope(scope);
  const query = new URLSearchParams({ scope: validatedScope });
  return getValidatedJson(`/briefing?${query.toString()}`, voiceBriefingResponseSchema);
}
