import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import {
  AttachmentService,
  type Attachment,
  type MulterFile,
} from '@propr/core';

export const MAX_GOAL_ATTACHMENTS_PER_PROMPT = 10;
const GOAL_ATTACHMENT_STORAGE_ROOT = path.join('/tmp/git-processor', 'goal-attachments');

export type GoalAttachment = Attachment;
export type PublicGoalAttachment = Omit<GoalAttachment, 'storedPath'>;

export function parseGoalAttachments(value: unknown): GoalAttachment[] {
  if (Array.isArray(value)) return value as GoalAttachment[];
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as GoalAttachment[] : [];
  } catch {
    return [];
  }
}

export function publicGoalAttachments(attachments: readonly GoalAttachment[]): PublicGoalAttachment[] {
  return attachments.map(attachment => ({
    id: attachment.id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    tokenEstimate: attachment.tokenEstimate,
    type: attachment.type,
  }));
}

function absoluteAttachmentPath(attachment: GoalAttachment): string {
  const storageRoot = path.resolve(GOAL_ATTACHMENT_STORAGE_ROOT);
  const absolutePath = path.resolve(process.cwd(), attachment.storedPath);
  if (absolutePath !== storageRoot && !absolutePath.startsWith(`${storageRoot}${path.sep}`)) {
    throw new Error('Goal attachment path is outside the configured storage directory');
  }
  return absolutePath;
}

export function appendGoalAttachments(message: string, attachments: readonly GoalAttachment[]): string {
  if (attachments.length === 0) return message;
  const entries = attachments.map(attachment => (
    `- ${JSON.stringify(attachment.originalName)} (${attachment.mimeType}): ${absoluteAttachmentPath(attachment)}`
  ));
  return `${message.trimEnd()}\n\nFiles uploaded with this prompt are available at these paths:\n${entries.join('\n')}`;
}

export async function goalUploadIdentity(files: readonly MulterFile[]): Promise<Array<Record<string, unknown>>> {
  return Promise.all(files.map(async file => ({
    name: file.originalname,
    type: file.mimetype,
    size: file.size,
    sha256: createHash('sha256').update(await fs.readFile(file.path)).digest('hex'),
  })));
}

export async function processGoalUploads(files: readonly MulterFile[], goalId: string): Promise<GoalAttachment[]> {
  const attachments: GoalAttachment[] = [];
  try {
    for (const file of files) {
      const attachment = await AttachmentService.processUpload(file, goalId, {
        storageRoot: GOAL_ATTACHMENT_STORAGE_ROOT,
        persistAttachment: async () => undefined,
      });
      attachments.push({
        ...attachment,
        storedPath: path.resolve(process.cwd(), attachment.storedPath),
      });
    }
    return attachments;
  } catch (error) {
    await deleteGoalAttachments(attachments);
    throw error;
  }
}

export async function removeTemporaryGoalUploads(files: readonly MulterFile[]): Promise<void> {
  await Promise.all(files.map(file => AttachmentService.removeTemporaryUpload(file.path).catch(() => undefined)));
}

export async function deleteGoalAttachments(attachments: readonly GoalAttachment[]): Promise<void> {
  await Promise.all(attachments.map(attachment => fs.remove(absoluteAttachmentPath(attachment)).catch(() => undefined)));
}

export async function deleteGoalAttachmentDirectory(goalId: string): Promise<void> {
  await fs.remove(path.join(GOAL_ATTACHMENT_STORAGE_ROOT, path.basename(goalId)));
}

export async function getGoalAttachmentContent(attachment: GoalAttachment): Promise<Buffer> {
  return fs.readFile(absoluteAttachmentPath(attachment));
}
