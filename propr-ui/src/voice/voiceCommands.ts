import type {
  VoiceBriefingAction,
  VoiceBriefingItem,
  VoiceBriefingItemKind,
  VoiceBriefingResponse,
  VoiceBriefingScope,
} from '@propr/shared';

export const MAX_VOICE_FOLLOW_UP_INSTRUCTION_LENGTH = 1_000;

export type ParsedVoiceCommand =
  | { type: 'briefing'; scope: VoiceBriefingScope }
  | { type: 'repeat' }
  | { type: 'open'; item: VoiceBriefingItem }
  | {
    type: 'pending_action';
    action: 'stop';
    item: VoiceBriefingItem;
    requiresConfirmation: true;
  }
  | {
    type: 'pending_action';
    action: 'follow_up';
    item: VoiceBriefingItem;
    instruction: string;
    requiresConfirmation: true;
  }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'invalid'; reason: string };

export type VoiceCommandResult = ParsedVoiceCommand;

const SPOKEN_NUMBERS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const SIMPLE_COMMANDS: Readonly<Record<string, ParsedVoiceCommand>> = {
  'catch me up': { type: 'briefing', scope: 'all' },
  'give me a briefing': { type: 'briefing', scope: 'all' },
  'brief me': { type: 'briefing', scope: 'all' },
  'what is running': { type: 'briefing', scope: 'running' },
  "what's running": { type: 'briefing', scope: 'running' },
  'running status': { type: 'briefing', scope: 'running' },
  'what needs attention': { type: 'briefing', scope: 'attention' },
  'what requires attention': { type: 'briefing', scope: 'attention' },
  'attention status': { type: 'briefing', scope: 'attention' },
  repeat: { type: 'repeat' },
  'repeat that': { type: 'repeat' },
  'repeat the briefing': { type: 'repeat' },
  'say that again': { type: 'repeat' },
  confirm: { type: 'confirm' },
  cancel: { type: 'cancel' },
  'never mind': { type: 'cancel' },
};

interface ParsedReference {
  kind: VoiceBriefingItemKind;
  position: number;
}

const REFERENCE_PATTERN = '(task|plan|system)\\s+([a-z]+|\\d+)';
const DIRECT_ACTION_PATTERN = new RegExp(`^(open|stop)\\s+${REFERENCE_PATTERN}[.!?]*$`, 'i');
const FOLLOW_UP_PATTERN = new RegExp(`^follow[\\s-]+up\\s+${REFERENCE_PATTERN}\\s+to\\s+(.+)$`, 'is');

function invalid(reason: string): ParsedVoiceCommand {
  return { type: 'invalid', reason };
}

function normalizeCommandText(transcript: string): string {
  return transcript
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .trim()
    .replace(/\s+/g, ' ')
    .trim();
}

function withoutCourtesy(text: string): string {
  return text
    .replace(/^please\s+/i, '')
    .replace(/\s+please[.!?]*$/i, '');
}

function parsePosition(token: string): number | null {
  const spoken = SPOKEN_NUMBERS[token.toLowerCase()];
  if (spoken !== undefined) return spoken;
  if (!/^[1-9]\d*$/.test(token)) return null;
  const numeric = Number(token);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function parseReference(kind: string, positionToken: string): ParsedReference | null {
  const position = parsePosition(positionToken);
  if (position === null) return null;
  return { kind: kind.toLowerCase() as VoiceBriefingItemKind, position };
}

function resolveReference(
  reference: ParsedReference,
  briefing: VoiceBriefingResponse | null | undefined,
): VoiceBriefingItem | ParsedVoiceCommand {
  if (!briefing) {
    return invalid('Get a briefing first so the reference can be resolved.');
  }

  const matches = briefing.items.filter(item => (
    item.kind === reference.kind && item.position === reference.position
  ));
  if (matches.length === 0) {
    return invalid(
      `${reference.kind} ${reference.position} is not in the latest briefing.`,
    );
  }
  if (matches.length > 1) {
    return invalid(
      `${reference.kind} ${reference.position} is ambiguous in the latest briefing.`,
    );
  }
  return matches[0];
}

function resolvedItem(
  reference: ParsedReference | null,
  briefing: VoiceBriefingResponse | null | undefined,
): VoiceBriefingItem | ParsedVoiceCommand {
  if (!reference) {
    return invalid('Use a numeric reference or a spoken number from one through ten.');
  }
  return resolveReference(reference, briefing);
}

function isInvalid(value: VoiceBriefingItem | ParsedVoiceCommand): value is ParsedVoiceCommand {
  return 'type' in value && value.type === 'invalid';
}

function unavailableAction(item: VoiceBriefingItem, action: VoiceBriefingAction): ParsedVoiceCommand {
  const actionName = action === 'follow_up' ? 'follow-up' : action;
  return invalid(`${item.reference} does not advertise the ${actionName} action.`);
}

function parseDirectAction(
  text: string,
  briefing: VoiceBriefingResponse | null | undefined,
): ParsedVoiceCommand | null {
  const match = DIRECT_ACTION_PATTERN.exec(text);
  if (!match) return null;

  const command = match[1].toLowerCase() as 'open' | 'stop';
  const item = resolvedItem(parseReference(match[2], match[3]), briefing);
  if (isInvalid(item)) return item;
  if (!item.actions.includes(command)) return unavailableAction(item, command);

  if (command === 'open') return { type: 'open', item };
  return {
    type: 'pending_action',
    action: 'stop',
    item,
    requiresConfirmation: true,
  };
}

function normalizedInstruction(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function containsEndpoint(value: string): boolean {
  return /(?:[a-z][a-z\d+.-]*:\/\/|www\.|(?:^|\s)\/\/\S|(?:^|\s)\/api(?:\/|\?|\s|$))/i.test(value);
}

function parseFollowUp(
  text: string,
  briefing: VoiceBriefingResponse | null | undefined,
): ParsedVoiceCommand | null {
  const match = FOLLOW_UP_PATTERN.exec(text);
  if (!match) return null;

  const instruction = normalizedInstruction(match[3]);
  if (!instruction) return invalid('A follow-up instruction is required.');
  if (instruction.length > MAX_VOICE_FOLLOW_UP_INSTRUCTION_LENGTH) {
    return invalid(
      'Follow-up instructions must be 1,000 characters or fewer.',
    );
  }
  if (containsEndpoint(instruction)) {
    return invalid('Voice follow-up instructions cannot contain a URL or API endpoint.');
  }

  const item = resolvedItem(parseReference(match[1], match[2]), briefing);
  if (isInvalid(item)) return item;
  if (!item.actions.includes('follow_up')) return unavailableAction(item, 'follow_up');

  return {
    type: 'pending_action',
    action: 'follow_up',
    item,
    instruction,
    requiresConfirmation: true,
  };
}

function malformedActionReason(text: string): string | null {
  if (/^(?:open|stop)\b/i.test(text)) {
    return 'Say open or stop followed by task, plan, or system and its number.';
  }
  if (/^follow[\s-]+up\b/i.test(text)) {
    return 'Say follow up, a task, plan, or system number, then “to” and the instruction.';
  }
  return null;
}

/**
 * Parse one recognized transcript against the latest validated briefing.
 *
 * The result is data only. In particular, stop and follow-up are inert pending
 * actions that a separate confirmation flow must approve and execute.
 */
export function parseVoiceCommand(
  transcript: string,
  latestBriefing?: VoiceBriefingResponse | null,
): ParsedVoiceCommand {
  if (typeof transcript !== 'string') return invalid('The voice transcript is invalid.');

  const text = withoutCourtesy(normalizeCommandText(transcript));
  if (!text) return invalid('No voice command was recognized.');

  const simpleText = text.replace(/[.!?]+$/, '').trim().toLowerCase();
  const simpleCommand = SIMPLE_COMMANDS[simpleText];
  if (simpleCommand) return simpleCommand;

  const directAction = parseDirectAction(text, latestBriefing);
  if (directAction) return directAction;

  const followUp = parseFollowUp(text, latestBriefing);
  if (followUp) return followUp;

  return invalid(
    malformedActionReason(text)
      ?? 'That voice command is not recognized. Try catch me up, repeat, open, stop, or follow up.',
  );
}
