import { githubInlineEligibility, VISUAL_PREVIEW_CONTENT_TYPES, type GitHubAttachmentCapacity } from '@propr/shared';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { storeManagedVisualPreviewOriginals, type ManagedVisualPreviewAssetResult } from './managedVisualPreviewStorage.js';
import { execa } from 'execa';
import { publicPreviewText, publishedOriginal, originalUnavailableText } from './visualPreviewPublication.js';
import {
  appendVisualPreviewSection,
  isSupportedVisualPreviewUploadToken,
  isVisualPreviewCredentialError,
  markVisualPreviewOAuthCredentialReauthRequired,
  redactSecrets,
  renderVisualPreviewSection,
  renderVisualPreviewUploadFailureSection,
  redactVisualPreviewPaths,
  resolveVisualPreviewUploadToken as resolveStoredVisualPreviewUploadToken,
  VisualPreviewCredentialError,
  VISUAL_PREVIEW_UPLOAD_TOKEN_ENV,
  type VisualPreviewEvidence
} from '@propr/core';

interface AttachmentCommandOptions {
  capacity?: GitHubAttachmentCapacity;
  args: string[];
  authToken: string;
  cwd: string;
}

export type AttachmentCommandRunner = (options: AttachmentCommandOptions) => Promise<{ stdout: string }>;

interface VisualPreviewAssetUploadOptions {
  capacity?: GitHubAttachmentCapacity;
  absolutePath: string;
  authToken: string;
  repositoryId: number;
}

export type VisualPreviewAssetUploader = (options: VisualPreviewAssetUploadOptions) => Promise<string>;

export { VISUAL_PREVIEW_UPLOAD_TOKEN_ENV };

export class VisualPreviewUploadAuthenticationError extends Error {
  readonly code = 'VISUAL_PREVIEW_AUTH_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'VisualPreviewUploadAuthenticationError';
  }
}

export function isVisualPreviewUploadAuthenticationError(error: unknown): boolean {
  return isVisualPreviewCredentialError(error) || error instanceof VisualPreviewUploadAuthenticationError || (
    error instanceof Error
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    && (error as { code: string }).code.startsWith('VISUAL_PREVIEW_AUTH_')
  );
}

/**
 * GitHub's user-attachment endpoint does not accept GitHub App installation
 * tokens. Keep this credential separate from the installation token used for
 * normal API requests and git operations.
 */
export async function resolveVisualPreviewUploadToken(
  environment?: NodeJS.ProcessEnv
): Promise<string> {
  if (!environment) return resolveStoredVisualPreviewUploadToken();
  const token = environment[VISUAL_PREVIEW_UPLOAD_TOKEN_ENV]?.trim();
  if (token && isSupportedVisualPreviewUploadToken(token)) return token;
  if (token) {
    throw new VisualPreviewCredentialError(
      'VISUAL_PREVIEW_AUTH_UNSUPPORTED',
      `${VISUAL_PREVIEW_UPLOAD_TOKEN_ENV} is not a GitHub OAuth or personal access token supported by attachment uploads.`,
    );
  }

  throw new VisualPreviewCredentialError(
    'VISUAL_PREVIEW_AUTH_MISSING',
    `${VISUAL_PREVIEW_UPLOAD_TOKEN_ENV} is not configured; GitHub attachment uploads require `
    + 'an OAuth token, classic personal access token, or fine-grained personal access token '
    + 'for a user with write access to the repository. GitHub App installation tokens cannot upload attachments.'
  );
}

async function validateAttachmentFile(absolutePath: string, capacity?: GitHubAttachmentCapacity): Promise<number> {
  const contentType = VISUAL_PREVIEW_CONTENT_TYPES[path.extname(absolutePath).toLowerCase()];
  if (!contentType) throw new Error(`Unsupported visual preview attachment type: ${path.basename(absolutePath)}`);
  let size: number;
  try { size = (await stat(absolutePath)).size; }
  catch { throw new Error('Visual preview source is unavailable'); }
  const eligibility = githubInlineEligibility(contentType, size, capacity);
  if (!eligibility.eligible) {
    if (eligibility.reason === 'size-limit-exceeded') throw new Error(`Visual preview exceeds the GitHub attachment limit of ${eligibility.limitBytes / (1024 * 1024)} MiB`);
    throw new Error(`Invalid visual preview attachment: ${eligibility.reason}`);
  }
  return eligibility.limitBytes;
}

/** Validate every original before GitHub credential lookup, repository lookup, or attachment upload. */
async function validateInlineEvidence(evidence: VisualPreviewEvidence): Promise<void> {
  for (const asset of evidence.assets) {
    await validateAttachmentFile(asset.absolutePath, evidence.githubAttachmentCapacity);
  }
}

const runAttachmentCommand: AttachmentCommandRunner = async ({ args, authToken, cwd, capacity }) => {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--attach') await validateAttachmentFile(args[++index], capacity);
  }
  try {
    const result = await execa('gh', args, {
      cwd,
      env: {
        ...process.env,
        GH_TOKEN: authToken,
        GH_PROMPT_DISABLED: '1',
        NO_COLOR: '1'
      },
      reject: true,
      timeout: 60_000
    });
    return { stdout: result.stdout };
  } catch (error) {
    const commandError = error as { code?: unknown; stderr?: unknown; stdout?: unknown };
    const detail = commandError.code === 'ENOENT'
      ? 'gh executable was not found in PATH'
      : typeof commandError.stderr === 'string' && commandError.stderr.trim()
        ? redactSecrets(commandError.stderr.trim()).replace(/\s+/g, ' ').slice(0, 1000)
        : '';
    const message = 'GitHub CLI could not upload visual preview attachments';
    const authFailure = /unsupported authentication type|bad credentials|authentication failed|http 401|requires authentication|not logged in/i.test(detail);
    if (authFailure) {
      try {
        await markVisualPreviewOAuthCredentialReauthRequired('github_rejected_token');
      } catch {
        // Preserve the original upload error. The Settings status can recover
        // once database access is restored.
      }
    }
    const wrappedError = (authFailure
      ? new VisualPreviewUploadAuthenticationError(message)
      : new Error(message)) as Error & { stdout?: string };
    const stdout = commandError.stdout;
    if (typeof stdout === 'string') wrappedError.stdout = redactSecrets(stdout);
    throw wrappedError;
  }
};

async function markRejectedUploadCredential(): Promise<void> {
  try {
    await markVisualPreviewOAuthCredentialReauthRequired('github_rejected_token');
  } catch {
    // Preserve the original upload error. The Settings status can recover
    // once database access is restored.
  }
}

export const uploadVisualPreviewAsset: VisualPreviewAssetUploader = async ({
  absolutePath,
  authToken,
  repositoryId,
  capacity,
}) => {
  const contentType = VISUAL_PREVIEW_CONTENT_TYPES[path.extname(absolutePath).toLowerCase()];
  if (!contentType) throw new Error(`Unsupported visual preview attachment type: ${path.basename(absolutePath)}`);

  const limit = await validateAttachmentFile(absolutePath, capacity);
  let body: Buffer;
  try { body = await readFile(absolutePath); }
  catch { throw new Error('Visual preview source is unavailable'); }
  if (body.byteLength > limit) throw new Error('Visual preview grew beyond the GitHub attachment limit');
  const uploadUrl = new URL('https://uploads.github.com/user-attachments/assets');
  uploadUrl.searchParams.set('name', path.basename(absolutePath));
  uploadUrl.searchParams.set('content_type', contentType);
  uploadUrl.searchParams.set('repository_id', String(repositoryId));

  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${authToken}`,
        'Content-Length': String(body.byteLength),
        'Content-Type': 'application/octet-stream',
        'User-Agent': 'ProPR',
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error('GitHub visual preview upload is unavailable');
  }

  if (!response.ok) {
    const message = response.status === 404
      ? `GitHub could not upload ${path.basename(absolutePath)} because the token owner does not have write access to the repository`
      : `GitHub could not upload ${path.basename(absolutePath)} (HTTP ${response.status})`;
    if (response.status === 401) await markRejectedUploadCredential();
    if ([401, 403, 404].includes(response.status)) throw new VisualPreviewUploadAuthenticationError(message);
    throw new Error(message);
  }

  const payload = await response.json() as { url?: unknown };
  if (typeof payload.url !== 'string' || !payload.url.startsWith('https://github.com/user-attachments/')) {
    throw new Error('GitHub uploaded a visual preview but did not return a valid attachment URL');
  }
  return payload.url;
};

interface BaseVisualPreviewPublicationOptions {
  taskId?: string;
  pullRequestNumber: number;
  owner: string;
  repo: string;
  body: string;
  evidence: VisualPreviewEvidence;
  /** Optional injection used by callers with an already-resolved upload credential. */
  authToken?: string;
  worktreePath: string;
  runCommand?: AttachmentCommandRunner;
  uploadAsset?: VisualPreviewAssetUploader;
  storeOriginals?: typeof storeManagedVisualPreviewOriginals;
}

async function storeOriginalsSafely(options: BaseVisualPreviewPublicationOptions): Promise<ManagedVisualPreviewAssetResult[]> {
  try {
    return await (options.storeOriginals ?? storeManagedVisualPreviewOriginals)(options.evidence, {
      taskId: options.taskId ?? options.evidence.taskId ?? '',
      repository: `${options.owner}/${options.repo}`,
      pullRequestNumber: options.pullRequestNumber,
    });
  } catch {
    // Optional original storage must never interrupt GitHub attachment publication.
    return [];
  }
}

function attachmentArguments(evidence: VisualPreviewEvidence): string[] {
  return evidence.assets.flatMap(asset => ['--attach', asset.absolutePath]);
}

function bodyWithLocalPreviews(options: BaseVisualPreviewPublicationOptions): string {
  const section = renderVisualPreviewSection({ ...options.evidence, assets: options.evidence.assets.map(asset => ({
    ...asset, title: publicPreviewText(asset.title, options.evidence),
    description: asset.description ? publicPreviewText(asset.description, options.evidence) : undefined,
  })) }, {
    useLocalPaths: true
  });
  return appendVisualPreviewSection(publicPreviewText(options.body, options.evidence), section);
}


function bodyWithUploadedPreviews(options: BaseVisualPreviewPublicationOptions, uploadedUrls: readonly string[]): string {
  if (uploadedUrls.length !== options.evidence.assets.length) {
    throw new Error('GitHub did not return an attachment URL for every visual preview');
  }
  const evidence = {
    ...options.evidence,
    assets: options.evidence.assets.map((asset, index) => ({
      ...asset,
      absolutePath: uploadedUrls[index],
    })),
  };
  return publicPreviewText(appendVisualPreviewSection(options.body, renderVisualPreviewSection(evidence, { useLocalPaths: true })), options.evidence);
}

function assertUploadedBodyHasNoLocalPaths(body: unknown, evidence: VisualPreviewEvidence): asserts body is string {
  if (typeof body !== 'string') {
    throw new Error('GitHub uploaded visual previews but did not return the published body');
  }
  const leakedPath = evidence.assets.find(asset => body.includes(asset.absolutePath)
    || body.includes(asset.absolutePath.replaceAll(' ', '%20')));
  if (leakedPath || redactVisualPreviewPaths(body) !== body) {
    throw new Error('GitHub did not replace a local visual preview path with an uploaded attachment URL');
  }
}

function assertUploadedBodyContainsUrls(body: string, uploadedUrls: readonly string[]): void {
  const missingUrl = uploadedUrls.find(url => !body.includes(url));
  if (missingUrl) throw new Error('GitHub published a visual preview comment without every uploaded attachment URL');
}

async function resolveRepositoryId(options: PublishPullRequestVisualPreviewOptions): Promise<number> {
  const response = await options.octokit.request<{ data: { id?: unknown } }>('GET /repos/{owner}/{repo}', {
    owner: options.owner,
    repo: options.repo,
  });
  const repositoryId = response.data.id;
  if (typeof repositoryId !== 'number' || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error('Could not determine which GitHub repository should own the visual preview attachments');
  }
  return repositoryId;
}

export interface PublishPullRequestVisualPreviewOptions extends BaseVisualPreviewPublicationOptions {
  pullRequestNumber: number;
  octokit: {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
  };
}

export async function publishPullRequestVisualPreviews(options: PublishPullRequestVisualPreviewOptions): Promise<void> {
  if (options.evidence.assets.length === 0) return;
  const originals = await storeOriginalsSafely(options);
  if (options.evidence.originalCapacity?.source === 'managed-storage' || originals.some(result => result.stored)) {
    await publishHybridVisualPreviews(options, originals);
    return;
  }
  await validateInlineEvidence(options.evidence);
  const runner = options.runCommand || runAttachmentCommand;
  await runner({
    args: [
      'pr', 'edit', String(options.pullRequestNumber),
      '--repo', `${options.owner}/${options.repo}`,
      '--body', bodyWithLocalPreviews(options),
      ...attachmentArguments(options.evidence)
    ],
    authToken: options.authToken ?? await resolveVisualPreviewUploadToken(),
    cwd: options.worktreePath,
    capacity: options.evidence.githubAttachmentCapacity,
  });
  const response = await options.octokit.request<{ data: { body?: string } }>('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: options.owner,
    repo: options.repo,
    pull_number: options.pullRequestNumber
  });
  assertUploadedBodyHasNoLocalPaths(response.data.body, options.evidence);
}

export interface PublishPullRequestCommentVisualPreviewOptions extends BaseVisualPreviewPublicationOptions {
  pullRequestNumber: number;
  octokit: {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
  };
  startingCommentId: number;
}

export interface PublishedVisualPreviewComment {
  html_url: string;
  body: string;
}

export async function publishPullRequestCommentVisualPreviews(
  options: PublishPullRequestCommentVisualPreviewOptions
): Promise<PublishedVisualPreviewComment> {
  if (options.evidence.assets.length === 0) {
    throw new Error('Cannot publish an attachment comment without preview assets');
  }
  const originals = await storeOriginalsSafely(options);
  if (options.evidence.originalCapacity?.source === 'managed-storage' || originals.some(result => result.stored)) {
    return publishHybridVisualPreviews(options, originals);
  }
  await validateInlineEvidence(options.evidence);
  const authToken = options.authToken ?? await resolveVisualPreviewUploadToken();
  const repositoryId = await resolveRepositoryId(options);
  const uploader = options.uploadAsset ?? uploadVisualPreviewAsset;
  const uploadedUrls: string[] = [];
  for (const asset of options.evidence.assets) {
    uploadedUrls.push(await uploader({
      absolutePath: asset.absolutePath,
      authToken,
      repositoryId,
      ...(options.evidence.githubAttachmentCapacity ? { capacity: options.evidence.githubAttachmentCapacity } : {}),
    }));
  }

  const body = bodyWithUploadedPreviews(options, uploadedUrls);
  const updatedStartingComment = await options.octokit.request<{ data: { html_url: string; body?: string } }>(
    'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
    {
      owner: options.owner,
      repo: options.repo,
      comment_id: options.startingCommentId,
      body,
    }
  );
  assertUploadedBodyHasNoLocalPaths(updatedStartingComment.data.body, options.evidence);
  assertUploadedBodyContainsUrls(updatedStartingComment.data.body, uploadedUrls);

  return {
    html_url: updatedStartingComment.data.html_url,
    body: updatedStartingComment.data.body,
  };
}

/** Publish only hosted URLs; each original and inline upload succeeds independently. */
async function publishHybridVisualPreviews(
  options: PublishPullRequestVisualPreviewOptions | PublishPullRequestCommentVisualPreviewOptions,
  originals: ManagedVisualPreviewAssetResult[],
): Promise<PublishedVisualPreviewComment> {
  const sections: string[] = [];
  const uploadedUrls: string[] = [];
  let uploadContext: Promise<{ authToken: string; repositoryId: number }> | undefined;
  let authenticationFailure = false;
  for (const [index, asset] of options.evidence.assets.entries()) {
    const result = originals.find(result => result.assetIndex === index && result.relativePath === asset.relativePath);
    const viewer = publishedOriginal(result, {
      taskId: options.taskId ?? options.evidence.taskId ?? '',
      repository: `${options.owner}/${options.repo}`, pullRequestNumber: options.pullRequestNumber,
    });
    let inlineUrl: string | undefined;
    try {
      await validateAttachmentFile(asset.absolutePath, options.evidence.githubAttachmentCapacity);
      uploadContext ??= (async () => ({
        authToken: options.authToken ?? await resolveVisualPreviewUploadToken(),
        repositoryId: await resolveRepositoryId(options),
      }))();
      inlineUrl = await (options.uploadAsset ?? uploadVisualPreviewAsset)({
        ...await uploadContext, absolutePath: asset.absolutePath, capacity: options.evidence.githubAttachmentCapacity,
      });
      if (!/^https:\/\/github\.com\/user-attachments\/[^\s<>]+$/.test(inlineUrl)) throw new Error('Invalid attachment URL');
      uploadedUrls.push(inlineUrl);
    } catch (error) {
      authenticationFailure ||= isVisualPreviewUploadAuthenticationError(error);
      inlineUrl = undefined;
    }
    const escape = (text: string) => publicPreviewText(text, options.evidence).replace(/([\\`*_[\]{}()<>#+.!|])/g, '\\$1');
    sections.push(`### ${escape(asset.title)}`);
    if (inlineUrl) sections.push(`![${asset.type === 'image' ? escape(asset.title) : ''}](${inlineUrl})`);
    if (asset.description) sections.push(escape(asset.description));
    if (viewer) {
      sections.push(`[View original (Connect sign-in required)](<${new URL(viewer.viewerUrl).href}>)\n\nOriginal retained until ${new Date(viewer.retentionExpiresAt).toISOString()}.`);
      uploadedUrls.push(new URL(viewer.viewerUrl).href);
    } else {
      sections.push(originalUnavailableText(result));
    }
    if (!inlineUrl) sections.push('Inline preview unavailable: GitHub size limits or upload failure. No preview files were committed.');
  }
  if (authenticationFailure) {
    const explanation = renderVisualPreviewUploadFailureSection({ assets: [], toolSuggestions: [] }, { authenticationFailure: true });
    sections.push(explanation.slice(explanation.indexOf('### Restore preview uploads')));
  }
  const suggestions = renderVisualPreviewSection({ assets: [], toolSuggestions: options.evidence.toolSuggestions }, {});
  if (suggestions) sections.push(suggestions.replace(/^.*?## Visual preview\n\n/s, ''));
  const body = publicPreviewText(appendVisualPreviewSection(options.body, ['<!-- propr-visual-preview -->', '## Visual preview', ...sections].join('\n\n')), options.evidence);
  assertUploadedBodyHasNoLocalPaths(body, options.evidence);
  const isComment = 'startingCommentId' in options;
  const response = await options.octokit.request<{ data: { body?: string; html_url: string } }>(
    isComment ? 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}' : 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}',
    { owner: options.owner, repo: options.repo, ...(isComment ? { comment_id: options.startingCommentId } : { pull_number: options.pullRequestNumber }), body },
  );
  assertUploadedBodyHasNoLocalPaths(response.data.body, options.evidence);
  assertUploadedBodyContainsUrls(response.data.body, uploadedUrls);
  return { body: response.data.body, html_url: response.data.html_url };
}
