import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createManagedPreviewStorageClient, issueQueue, logger, type VisualPreviewEvidence } from '@propr/core';
import { ROUTING_STATUS_REDIS_KEY } from '@propr/shared';

const contentTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm',
};

/** Store originals independently of GitHub publication; no managed URLs enter a PR or log. */
export async function storeManagedVisualPreviewOriginals(evidence: VisualPreviewEvidence, repository: string): Promise<void> {
  try {
    const client = createManagedPreviewStorageClient(async () => (await issueQueue.client).get(ROUTING_STATUS_REDIS_KEY));
    if (!(await client.getStatus()).enabled) return;
    for (const asset of evidence.assets) {
      const contentType = contentTypes[path.extname(asset.absolutePath).toLowerCase()];
      if (!contentType) continue;
      const result = await client.uploadOriginal({ bytes: await readFile(asset.absolutePath), contentType, repository });
      if (!result.stored) logger.warn({ code: result.code }, 'Managed preview original was not stored; continuing GitHub publication');
    }
  } catch {
    logger.warn('Managed preview storage unavailable; continuing GitHub publication');
  }
}
