export type GitHubAttachmentPlanOverride = 'auto' | 'free' | 'paid';
export type GitHubAttachmentPlan = 'free' | 'paid' | 'unknown';

export interface GitHubAttachmentCapacity {
  override: GitHubAttachmentPlanOverride;
  detectedPlan: GitHubAttachmentPlan;
  effectivePlan: 'free' | 'paid';
  source: 'override' | 'detected' | 'conservative-fallback';
  imageLimitBytes: number;
  videoLimitBytes: number;
}

export const MIB = 1024 * 1024;

/** Supplied by a trusted managed-storage capability resolver, never repository configuration. */
export interface VisualPreviewOriginalCapability {
  maxBytes: number;
}

export interface VisualPreviewOriginalCapacity {
  source: 'legacy' | 'managed-storage';
  imageLimitBytes: number;
  videoLimitBytes: number;
}

export const MAX_VISUAL_PREVIEW_ORIGINAL_BYTES = 500 * MIB;

/** GitHub limits are only the legacy staging fallback, not a managed-original ceiling. */
export function resolveVisualPreviewOriginalCapacity(
  capability?: VisualPreviewOriginalCapability,
  githubCapacity = resolveGitHubAttachmentCapacity(),
): VisualPreviewOriginalCapacity {
  if (capability && Number.isSafeInteger(capability.maxBytes) && capability.maxBytes > 0) {
    const limit = Math.min(capability.maxBytes, MAX_VISUAL_PREVIEW_ORIGINAL_BYTES);
    return { source: 'managed-storage', imageLimitBytes: limit, videoLimitBytes: limit };
  }
  return {
    source: 'legacy',
    imageLimitBytes: githubAttachmentLimitBytes('image/png', githubCapacity)!,
    videoLimitBytes: githubAttachmentLimitBytes('video/mp4', githubCapacity)!,
  };
}

export type GitHubInlineEligibility =
  | { eligible: true; limitBytes: number }
  | { eligible: false; reason: 'unsupported-content-type' | 'invalid-size'; limitBytes: number | null }
  | { eligible: false; reason: 'size-limit-exceeded'; limitBytes: number };

export function githubInlineEligibility(
  contentType: string,
  sizeBytes: number,
  capacity = resolveGitHubAttachmentCapacity(),
): GitHubInlineEligibility {
  const limitBytes = githubAttachmentLimitBytes(contentType, capacity);
  if (limitBytes === null) return { eligible: false, reason: 'unsupported-content-type', limitBytes };
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return { eligible: false, reason: 'invalid-size', limitBytes };
  if (sizeBytes > limitBytes) return { eligible: false, reason: 'size-limit-exceeded', limitBytes };
  return { eligible: true, limitBytes };
}

export function normalizeGitHubAttachmentPlanOverride(value: unknown): GitHubAttachmentPlanOverride {
  return value === 'free' || value === 'paid' ? value : 'auto';
}

/** Only explicit, recognized account plans establish paid status. */
export function detectGitHubAttachmentPlan(account: unknown): GitHubAttachmentPlan {
  if (!account || typeof account !== 'object') return 'unknown';
  const plan = (account as { plan?: unknown }).plan;
  if (!plan || typeof plan !== 'object') return 'unknown';
  const name = (plan as { name?: unknown }).name;
  if (typeof name !== 'string') return 'unknown';
  switch (name.toLowerCase()) {
    case 'free': return 'free';
    case 'pro':
    case 'team':
    case 'enterprise':
    // Legacy paid personal plans returned by GET /user.
    case 'micro':
    case 'small':
    case 'medium':
    case 'large': return 'paid';
    default: return 'unknown';
  }
}

export function resolveGitHubAttachmentCapacity(
  configured: unknown = 'auto',
  detectedPlan: GitHubAttachmentPlan = 'unknown',
): GitHubAttachmentCapacity {
  const override = normalizeGitHubAttachmentPlanOverride(configured);
  const effectivePlan = override === 'auto' ? (detectedPlan === 'paid' ? 'paid' : 'free') : override;
  return {
    override,
    detectedPlan,
    effectivePlan,
    source: override !== 'auto' ? 'override' : detectedPlan === 'unknown' ? 'conservative-fallback' : 'detected',
    imageLimitBytes: 10 * MIB,
    videoLimitBytes: (effectivePlan === 'paid' ? 100 : 10) * MIB,
  };
}

export const VISUAL_PREVIEW_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

/** Unsupported content types are never eligible for inline attachment upload. */
export function githubAttachmentLimitBytes(contentType: string, capacity = resolveGitHubAttachmentCapacity()): number | null {
  if (!Object.values(VISUAL_PREVIEW_CONTENT_TYPES).includes(contentType)) return null;
  return contentType.startsWith('image/') ? 10 * MIB : (capacity.effectivePlan === 'paid' ? 100 : 10) * MIB;
}

export function describeGitHubAttachmentCapacity(capacity: GitHubAttachmentCapacity): string {
  const state = capacity.source === 'conservative-fallback'
    ? 'Auto unresolved; using conservative Free limits'
    : `${capacity.effectivePlan === 'paid' ? 'Paid' : 'Free'} (${capacity.source === 'override' ? 'repository override' : 'detected'})`;
  return `${state}. Images: 10 MiB; videos: ${capacity.videoLimitBytes / MIB} MiB.`;
}
