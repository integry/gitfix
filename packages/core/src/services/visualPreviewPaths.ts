export const VISUAL_PREVIEW_DIRECTORY = '.propr/previews';
export const VISUAL_PREVIEW_SOURCE_DIRECTORY = '.propr/preview-src';
export const VISUAL_PREVIEW_MANIFEST = `${VISUAL_PREVIEW_DIRECTORY}/manifest.json`;

/**
 * Worktree-local visual preview artifacts. These paths are runtime output and
 * must never be included in an implementation commit.
 */
export const VISUAL_PREVIEW_RUNTIME_DIRECTORIES = [
  VISUAL_PREVIEW_DIRECTORY,
  VISUAL_PREVIEW_SOURCE_DIRECTORY,
] as const;
