import type { ConversationEvent } from '@propr/shared';
import { parseClaudeOutputToConversationResult } from '../routes/liveDetailsCodexParser.js';
import { detectStoredOutputFormat } from '../routes/liveDetailsStoredOutputFormat.js';
import { parseRedisOutput, type ParsedRedisOutput, type RedisOutputParseOptions } from './redisOutputParser.js';

/** Matches the conversation-file watcher budget so live payloads stay bounded. */
const MAX_LIVE_EVENTS = 100;

/** Matches the Redis parser's synthetic timestamp spacing for other providers. */
const SYNTHETIC_TIMESTAMP_STEP_MS = 1000;

/**
 * Project raw agent stdout streamed through Redis into live events.
 *
 * Claude emits `stream-json` envelopes that the Codex/OpenCode/Antigravity
 * parser silently mangles - tool calls disappear and only a few assistant
 * texts survive - so route that format to the Claude transcript parser and
 * leave every other provider on the generic Redis parser.
 */
export function parseAgentStreamOutput(output: string, options: RedisOutputParseOptions = {}): ParsedRedisOutput {
  if (detectStoredOutputFormat(output) === 'claude') return projectClaudeStreamOutput(output, options);
  return parseRedisOutput(output.split('\n').filter(line => line.trim()), options);
}

function projectClaudeStreamOutput(output: string, options: RedisOutputParseOptions): ParsedRedisOutput {
  // Container entrypoints print plain text before Claude's first envelope, and
  // this projection re-runs on every live poll, so drop non-JSON lines here
  // instead of warning about each of them every couple of seconds.
  const envelopeLines = output.split('\n').filter(line => line.trimStart().startsWith('{'));
  const stampedLines = withSyntheticEnvelopeTimestamps(envelopeLines, options.executionStartTimestamp);
  const result = parseClaudeOutputToConversationResult(stampedLines.join('\n'));
  const events = result.events as unknown as ConversationEvent[];
  return {
    events: events.length > MAX_LIVE_EVENTS ? events.slice(-MAX_LIVE_EVENTS) : events,
    todos: result.todos,
    currentTask: result.currentTask,
    tokenUsage: result.tokenUsage,
    totalEventCount: events.length,
    // Claude has no native goal protocol: goal runs pipe the goal prompt into
    // the regular CLI (ClaudeAgent), and thread/goal/updated records are only
    // written by Codex's app-server connection, so a Claude stream never
    // carries native goal records to project.
    nativeGoal: null,
  };
}

/**
 * Claude stream-json envelopes carry no timestamps (conversation-file
 * transcripts do), so the Claude parser would stamp every event with the
 * parse time - a value that shifts on each poll. Synthesize monotonic
 * timestamps from the execution start instead, mirroring the Redis parser's
 * synthetic timestamps for the other providers.
 */
function withSyntheticEnvelopeTimestamps(lines: string[], executionStartTimestamp?: string | null): string[] {
  const startMs = executionStartTimestamp ? new Date(executionStartTimestamp).getTime() : NaN;
  if (Number.isNaN(startMs)) return lines;
  return lines.map((line, index) => {
    try {
      const envelope = JSON.parse(line) as { timestamp?: unknown };
      if (envelope.timestamp) return line;
      envelope.timestamp = new Date(startMs + index * SYNTHETIC_TIMESTAMP_STEP_MS).toISOString();
      return JSON.stringify(envelope);
    } catch {
      return line;
    }
  });
}
