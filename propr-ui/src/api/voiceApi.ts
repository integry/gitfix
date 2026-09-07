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

const VOICE_API_URL = `${API_BASE_URL}/api/voice`;

async function getValidatedJson<T>(
  path: string,
  schema: RuntimeVoiceSchema<T>,
): Promise<T> {
  const response = await apiFetch(`${VOICE_API_URL}${path}`, {
    method: 'GET',
    credentials: 'include',
  });
  await handleApiResponse(response);
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
