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

/** Remove runtime file references from public prose and persisted task output. */
export function redactVisualPreviewPaths(text: string): string {
  // Accept native, JSON-escaped, and URL-encoded separators. The staging root
  // deliberately has no .propr component after evidence leaves the worktree.
  const separator = String.raw`(?:[/\\]|%2f|%5c)`;
  const runtime = String.raw`(?:\.propr${separator}+(?:previews|preview-src)|propr-previews)${separator}+`;
  const containsRuntimePath = new RegExp(runtime, 'i');
  // Scan each token once, instead of backtracking over potentially large agent
  // output looking for a path prefix. Quoted paths may contain spaces.
  return text
    .replace(/<[^<>\r\n]*>|"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`/g,
      value => containsRuntimePath.test(value) ? `${value[0]}[local preview omitted]${value.at(-1)}` : value)
    .replace(/[^\s<>"'`]+/g, value => containsRuntimePath.test(value) ? '[local preview omitted]' : value);
}

/** Apply path redaction to a public JSON projection without damaging JSON escapes. */
export function redactVisualPreviewValue(value: unknown): unknown {
  const serialized = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'string' ? redactVisualPreviewPaths(item) : item);
  return serialized === undefined ? undefined : JSON.parse(serialized);
}
