import {
  parseVoiceBriefingScope,
  voiceBriefingResponseSchema,
  voiceCapabilitiesResponseSchema,
  type RuntimeVoiceSchema,
  type VoiceBriefingResponse,
  type VoiceBriefingScope,
  type VoiceCapabilitiesResponse,
} from '@propr/shared';
import { apiFetch, handleApiResponse } from './apiClient';

export class VoiceBackendUnavailableError extends Error {
  readonly code = 'VOICE_BACKEND_UNAVAILABLE';

  constructor() {
    super('Voice briefings are unavailable on the connected server (HTTP 404). Update the server runtime to a version with voice briefings, then reconnect. Updating the desktop app alone does not update the server.');
    this.name = 'VoiceBackendUnavailableError';
  }
}

async function getValidatedJson<T>(
  path: string,
  schema: RuntimeVoiceSchema<T>,
): Promise<T> {
  const response = await apiFetch(`/api/voice${path}`, {
    method: 'GET',
    credentials: 'include',
  });
  if (response.status === 404) throw new VoiceBackendUnavailableError();
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
