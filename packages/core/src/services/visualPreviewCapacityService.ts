import {
  detectGitHubAttachmentPlan,
  resolveGitHubAttachmentCapacity,
  type GitHubAttachmentCapacity,
  type GitHubAttachmentPlanOverride,
} from '@propr/shared';
import { resolveVisualPreviewUploadToken } from './visualPreviewOAuthCredentialService.js';

/**
 * Best effort using the existing attachment uploader's credential. GET /user
 * may omit plan for its current permissions; never request scopes, billing
 * access, a new credential, or a Connect backend change to resolve it.
 */
export async function loadGitHubAttachmentCapacity(
  override: GitHubAttachmentPlanOverride = 'auto',
  dependencies: { resolveToken?: () => Promise<string>; fetch?: typeof fetch } = {},
): Promise<GitHubAttachmentCapacity> {
  if (override !== 'auto') return resolveGitHubAttachmentCapacity(override);
  try {
    const token = await (dependencies.resolveToken ?? resolveVisualPreviewUploadToken)();
    const response = await (dependencies.fetch ?? fetch)('https://api.github.com/user', {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'ProPR' },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return resolveGitHubAttachmentCapacity(override, detectGitHubAttachmentPlan(await response.json()));
  } catch {
    // Missing credentials, denied access, timeouts, malformed responses, and
    // network failures all leave detection unresolved. Do not affect auth state.
  }
  return resolveGitHubAttachmentCapacity(override);
}
