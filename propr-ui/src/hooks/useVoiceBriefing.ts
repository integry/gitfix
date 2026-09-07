import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  VoiceBriefingItem,
  VoiceBriefingResponse,
  VoiceBriefingScope,
} from '@propr/shared';
import { postTaskFollowup, stopTaskExecution } from '../api/proprApi';
import { getVoiceBriefing } from '../api/voiceApi';
import {
  BrowserSpeechError,
  getBrowserSpeechCapabilities,
  listenOnce,
  speakOnce,
  type BrowserSpeechCapabilities,
  type CancellableSpeech,
} from '../voice/browserSpeech';
import {
  parseVoiceCommand,
  type ParsedVoiceCommand,
} from '../voice/voiceCommands';

export type VoiceBriefingPhase =
  | 'idle'
  | 'loading'
  | 'speaking'
  | 'listening'
  | 'confirming'
  | 'executing'
  | 'error';

export type PendingVoiceBriefingAction = Extract<
  ParsedVoiceCommand,
  { type: 'pending_action' }
>;

export interface UseVoiceBriefingOptions {
  /** BCP 47 language tag used for both browser speech APIs. */
  language?: string;
  recognitionTimeoutMs?: number;
  /** Called for a resolved, server-provided application path. */
  onOpenItem?: (item: VoiceBriefingItem) => void;
}

export interface VoiceBriefingController {
  phase: VoiceBriefingPhase;
  briefing: VoiceBriefingResponse | null;
  pendingAction: PendingVoiceBriefingAction | null;
  transcript: string | null;
  error: string | null;
  capabilities: BrowserSpeechCapabilities;
  requestBriefing: (scope?: VoiceBriefingScope) => Promise<void>;
  repeatBriefing: () => Promise<void>;
  startListening: () => Promise<void>;
  handleTranscript: (transcript: string) => Promise<void>;
  confirmPendingAction: () => Promise<void>;
  cancelPendingAction: () => void;
  clearError: () => void;
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function confirmationPrompt(action: PendingVoiceBriefingAction): string {
  if (action.action === 'stop') {
    return `Stop ${action.item.reference}, ${action.item.title}? Say confirm to stop it, or cancel.`;
  }
  return `Follow up on ${action.item.reference} with: ${action.instruction}. Say confirm to send it, or cancel.`;
}

/**
 * Coordinate one on-demand briefing and one-shot browser speech interactions.
 * The hook deliberately owns no socket, interval, or task-completion polling.
 */
export function useVoiceBriefing(
  options: UseVoiceBriefingOptions = {},
): VoiceBriefingController {
  const [phase, setPhaseState] = useState<VoiceBriefingPhase>('idle');
  const [briefing, setBriefing] = useState<VoiceBriefingResponse | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingVoiceBriefingAction | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const capabilities = useMemo(getBrowserSpeechCapabilities, []);

  const mountedRef = useRef(true);
  const phaseRef = useRef<VoiceBriefingPhase>('idle');
  const briefingRef = useRef<VoiceBriefingResponse | null>(null);
  const pendingActionRef = useRef<PendingVoiceBriefingAction | null>(null);
  const scopeRef = useRef<VoiceBriefingScope>('all');
  const speechRef = useRef<CancellableSpeech | null>(null);
  const speechRunRef = useRef(0);
  const recognitionRef = useRef<AbortController | null>(null);
  const mutationInFlightRef = useRef(false);
  const requestRunRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const setPhase = useCallback((next: VoiceBriefingPhase) => {
    phaseRef.current = next;
    if (mountedRef.current) setPhaseState(next);
  }, []);

  const cancelSpeech = useCallback(() => {
    speechRunRef.current += 1;
    const speech = speechRef.current;
    speechRef.current = null;
    speech?.cancel();
  }, []);

  const cancelRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    recognition?.abort();
  }, []);

  const showError = useCallback((message: string) => {
    if (!mountedRef.current) return;
    setError(message);
    setPhase('error');
  }, [setPhase]);

  const speak = useCallback(async (
    text: string,
    settledPhase: VoiceBriefingPhase,
    exposeSpeakingPhase = true,
  ): Promise<void> => {
    cancelSpeech();
    if (!capabilities.speechSynthesis || document.visibilityState === 'hidden') {
      setPhase(settledPhase);
      return;
    }

    const run = speechRunRef.current;
    const speech = speakOnce(text, { lang: optionsRef.current.language });
    speechRef.current = speech;
    setPhase(exposeSpeakingPhase ? 'speaking' : settledPhase);
    try {
      await speech.promise;
    } catch (speechError) {
      if (!(speechError instanceof BrowserSpeechError && speechError.category === 'cancelled')) {
        // Speech is an enhancement; keep the structured content usable visually.
        if (mountedRef.current && speechRunRef.current === run) {
          setError(messageFrom(speechError, 'The briefing could not be spoken.'));
        }
      }
    } finally {
      if (speechRunRef.current === run) {
        speechRef.current = null;
        setPhase(settledPhase);
      }
    }
  }, [cancelSpeech, capabilities.speechSynthesis, setPhase]);

  const storeBriefing = useCallback((next: VoiceBriefingResponse) => {
    briefingRef.current = next;
    scopeRef.current = next.scope;
    if (mountedRef.current) setBriefing(next);
  }, []);

  const requestBriefing = useCallback(async (
    scope: VoiceBriefingScope = 'all',
  ): Promise<void> => {
    if (mutationInFlightRef.current) return;
    const run = requestRunRef.current + 1;
    requestRunRef.current = run;
    cancelRecognition();
    cancelSpeech();
    pendingActionRef.current = null;
    if (mountedRef.current) {
      setPendingAction(null);
      setError(null);
    }
    setPhase('loading');

    try {
      const next = await getVoiceBriefing(scope);
      if (!mountedRef.current || requestRunRef.current !== run) return;
      storeBriefing(next);
      await speak(next.speechText, 'idle');
    } catch (requestError) {
      if (!mountedRef.current || requestRunRef.current !== run) return;
      showError(messageFrom(requestError, 'The voice briefing could not be loaded.'));
    }
  }, [cancelRecognition, cancelSpeech, setPhase, showError, speak, storeBriefing]);

  const repeatBriefing = useCallback(async (): Promise<void> => {
    if (mutationInFlightRef.current) return;
    const latest = briefingRef.current;
    if (!latest) {
      showError('Get a briefing first so it can be repeated.');
      return;
    }
    if (mountedRef.current) setError(null);
    await speak(latest.speechText, pendingActionRef.current ? 'confirming' : 'idle');
  }, [showError, speak]);

  const cancelPendingAction = useCallback(() => {
    cancelRecognition();
    cancelSpeech();
    pendingActionRef.current = null;
    if (mountedRef.current) {
      setPendingAction(null);
      setError(null);
    }
    if (!mutationInFlightRef.current) setPhase('idle');
  }, [cancelRecognition, cancelSpeech, setPhase]);

  const confirmPendingAction = useCallback(async (): Promise<void> => {
    const action = pendingActionRef.current;
    if (!action || mutationInFlightRef.current) return;

    mutationInFlightRef.current = true;
    cancelRecognition();
    cancelSpeech();
    pendingActionRef.current = null;
    if (mountedRef.current) {
      setPendingAction(null);
      setError(null);
    }
    setPhase('executing');

    try {
      if (action.action === 'stop') {
        await stopTaskExecution(action.item.id);
      } else {
        await postTaskFollowup(action.item.id, action.instruction);
      }
    } catch (mutationError) {
      if (mountedRef.current) {
        showError(messageFrom(mutationError, 'The task action could not be completed.'));
      }
      mutationInFlightRef.current = false;
      return;
    }

    if (!mountedRef.current) {
      mutationInFlightRef.current = false;
      return;
    }

    try {
      // This is a single fresh snapshot, not task-completion polling.
      const refreshed = await getVoiceBriefing(scopeRef.current);
      if (!mountedRef.current) return;
      storeBriefing(refreshed);
      await speak(refreshed.speechText, 'idle');
    } catch (refreshError) {
      if (mountedRef.current) {
        showError(messageFrom(
          refreshError,
          'The task action completed, but the briefing could not be refreshed.',
        ));
      }
    } finally {
      mutationInFlightRef.current = false;
    }
  }, [cancelRecognition, cancelSpeech, setPhase, showError, speak, storeBriefing]);

  const handleTranscript = useCallback(async (spokenText: string): Promise<void> => {
    if (!mountedRef.current || mutationInFlightRef.current) return;
    setTranscript(spokenText);
    setError(null);
    const command = parseVoiceCommand(spokenText, briefingRef.current);

    if (pendingActionRef.current && command.type !== 'confirm' && command.type !== 'cancel') {
      setPhase('confirming');
      setError('Say confirm to execute the pending action, or cancel.');
      return;
    }

    switch (command.type) {
      case 'briefing':
        await requestBriefing(command.scope);
        return;
      case 'repeat':
        await repeatBriefing();
        return;
      case 'open':
        optionsRef.current.onOpenItem?.(command.item);
        setPhase('idle');
        return;
      case 'pending_action':
        pendingActionRef.current = command;
        setPendingAction(command);
        await speak(confirmationPrompt(command), 'confirming', false);
        return;
      case 'confirm':
        if (!pendingActionRef.current) {
          showError('There is no pending action to confirm.');
          return;
        }
        await confirmPendingAction();
        return;
      case 'cancel':
        cancelPendingAction();
        return;
      case 'invalid':
        showError(command.reason);
    }
  }, [
    cancelPendingAction,
    confirmPendingAction,
    repeatBriefing,
    requestBriefing,
    setPhase,
    showError,
    speak,
  ]);

  const startListening = useCallback(async (): Promise<void> => {
    if (recognitionRef.current
      || mutationInFlightRef.current
      || phaseRef.current === 'loading') return;
    cancelSpeech();
    if (mountedRef.current) setError(null);
    setPhase('listening');
    const controller = new AbortController();
    recognitionRef.current = controller;

    // listenOnce starts recognition synchronously here, preserving user-gesture activation.
    const listening = listenOnce({
      signal: controller.signal,
      lang: optionsRef.current.language,
      timeoutMs: optionsRef.current.recognitionTimeoutMs,
    });
    try {
      const spokenText = await listening;
      if (!mountedRef.current || recognitionRef.current !== controller) return;
      recognitionRef.current = null;
      await handleTranscript(spokenText);
    } catch (recognitionError) {
      if (!mountedRef.current || recognitionRef.current !== controller) return;
      recognitionRef.current = null;
      if (recognitionError instanceof BrowserSpeechError
        && recognitionError.category === 'cancelled') {
        setPhase(pendingActionRef.current ? 'confirming' : 'idle');
        return;
      }
      showError(messageFrom(recognitionError, 'The voice command could not be recognized.'));
    }
  }, [cancelSpeech, handleTranscript, setPhase, showError]);

  const clearError = useCallback(() => {
    if (mountedRef.current) setError(null);
    setPhase(pendingActionRef.current ? 'confirming' : 'idle');
  }, [setPhase]);

  useEffect(() => {
    mountedRef.current = true;
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') return;
      cancelRecognition();
      cancelSpeech();
      if (!mutationInFlightRef.current && phaseRef.current !== 'loading') {
        setPhase(pendingActionRef.current ? 'confirming' : 'idle');
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      mountedRef.current = false;
      requestRunRef.current += 1;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      cancelRecognition();
      cancelSpeech();
    };
  }, [cancelRecognition, cancelSpeech, setPhase]);

  return {
    phase,
    briefing,
    pendingAction,
    transcript,
    error,
    capabilities,
    requestBriefing,
    repeatBriefing,
    startListening,
    handleTranscript,
    confirmPendingAction,
    cancelPendingAction,
    clearError,
  };
}
