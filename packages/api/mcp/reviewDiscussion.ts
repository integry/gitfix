import { McpError } from './config.js';
import { getProcessedReviewCommentsKey } from '@propr/core';
import { parseStructuredReview } from '../../../src/jobs/reviewOutputParser.js';
import type { McpPrincipal } from './policy.js';
import type { ToolDeps } from './tools.js';

interface ReviewComment { id: number; body?: string | null; html_url: string; created_at: string; user: { login: string } | null }

export async function projectDiscussionComment(deps: ToolDeps, comment: ReviewComment, target: { repository: string; pullRequest: number; head: string; bodyOffset: number }): Promise<Record<string, unknown>> {
  const body = comment.body || '';
  const marker = /<!-- propr:ai-review\b([^>]*)-->/.exec(body);
  const metadata = marker?.[1] || '';
  const reviewedHead = /\bhead="([a-f0-9]{40})"/.exec(metadata)?.[1] || null;
  const taskId = /\btask="([^"]+)"/.exec(metadata)?.[1];
  let review;
  if (marker) {
    const [owner, repo] = target.repository.split('/');
    const key = getProcessedReviewCommentsKey(owner, repo, target.pullRequest);
    const [processedComments, processedFindings] = await Promise.all([deps.redisClient.sMembers(key), deps.redisClient.sMembers(`${key}:findings`)]);
    const parsed = parseStructuredReview(body);
    const eligible = Date.parse(comment.created_at) >= Date.now() - 7 * 24 * 3600 * 1000 && (reviewedHead === null || reviewedHead === target.head);
    const findings = parsed.actionableFindings.map(finding => {
      const consumed = processedComments.includes(String(comment.id)) || processedFindings.includes(`${comment.id}:F:${finding.id}`);
      return { ...finding, consumed, current: eligible && !consumed };
    });
    review = { ...parsed, actionableFindings: findings, currentFindingIds: findings.filter(finding => finding.current).map(finding => finding.id),
      reviewedHead, matchesCurrentHead: reviewedHead === null ? null : reviewedHead === target.head,
      partial: /\bpartial="true"/.test(metadata), coverage: reviewedHead === null ? 'legacy_head_unknown' : /\bpartial="true"/.test(metadata) ? 'partial' : 'full_diff',
      taskId: taskId ? decodeTaskId(taskId) : null };
  }
  return { id: comment.id, url: comment.html_url, author: comment.user?.login, createdAt: comment.created_at,
    body: body.slice(target.bodyOffset, target.bodyOffset + 4096), nextBodyOffset: target.bodyOffset + 4096 < body.length ? target.bodyOffset + 4096 : null, review };
}

export async function readDiscussionComment(principal: McpPrincipal, target: { repository: string; commentId: number; pullRequest: number }) {
  const [owner, repo] = target.repository.split('/');
  const { data } = await principal.github.request('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', { owner, repo, comment_id: target.commentId });
  // A comment ID is repository-wide. Bind it to the requested PR as well.
  if (!data.issue_url.endsWith(`/issues/${target.pullRequest}`)) throw new McpError('NOT_FOUND', 'Comment does not belong to this pull request.', 404);
  return data;
}

function decodeTaskId(value: string): string | null {
  try { return decodeURIComponent(value); } catch { return null; }
}
