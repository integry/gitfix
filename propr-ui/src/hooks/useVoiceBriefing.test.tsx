import { act, renderHook } from '@testing-library/react';
import { voiceBriefingResponseSchema, type VoiceBriefingResponse } from '@propr/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postTaskFollowup, stopTaskExecution } from '../api/proprApi';
import { getVoiceBriefing } from '../api/voiceApi';
import {
  getBrowserSpeechCapabilities,
  listenOnce,
  speakOnce,
} from '../voice/browserSpeech';
import { useVoiceBriefing } from './useVoiceBriefing';

let currentVisibility: DocumentVisibilityState = 'visible';

vi.mock('../api/proprApi', () => ({
  postTaskFollowup: vi.fn(),
  stopTaskExecution: vi.fn(),
}));

vi.mock('../api/voiceApi', () => ({
  getVoiceBriefing: vi.fn(),
}));

vi.mock('../voice/browserSpeech', async importOriginal => {
  const actual = await importOriginal<typeof import('../voice/browserSpeech')>();
  return {
    ...actual,
    getBrowserSpeechCapabilities: vi.fn(),
    listenOnce: vi.fn(),
    speakOnce: vi.fn(),
  };
});

function snapshot(
  speechText = 'One task needs attention.',
  status = 'running',
): VoiceBriefingResponse {
  return voiceBriefingResponseSchema.parse({
    generatedAt: '2026-09-07T09:35:00.000Z',
    scope: 'all',
    headline: 'One task needs attention',
    speechText,
    counts: { running: 1, queued: 0, attention: 1, plans: 0, total: 1 },
    items: [{
      reference: 'task 1',
      position: 1,
      kind: 'task',
      id: 'task-1',
      title: 'Voice controller',
      repository: 'integry/propr',
      status,
      summary: 'Waiting for a decision.',
      href: '/tasks/task-1',
      requiresAttention: true,
      actions: ['open', 'stop', 'follow_up'],
      updatedAt: '2026-09-07T09:30:00.000Z',
    }],
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useVoiceBriefing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    currentVisibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => currentVisibility);
    vi.mocked(getBrowserSpeechCapabilities).mockReturnValue({
      speechSynthesis: true,
      speechRecognition: true,
    });
    vi.mocked(speakOnce).mockReturnValue({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    });
    vi.mocked(getVoiceBriefing).mockResolvedValue(snapshot());
    vi.mocked(stopTaskExecution).mockResolvedValue({
      success: true,
      message: 'Stopping',
      containerStopped: true,
    });
    vi.mocked(postTaskFollowup).mockResolvedValue({ success: true, message: 'Posted' });
  });

  it('fetches a fresh one-shot briefing and retains it when speech output is unavailable', async () => {
    vi.mocked(getBrowserSpeechCapabilities).mockReturnValue({
      speechSynthesis: false,
      speechRecognition: false,
    });
    const briefing = snapshot('Visual briefing text.');
    vi.mocked(getVoiceBriefing).mockResolvedValue(briefing);
    const { result } = renderHook(() => useVoiceBriefing());

    await act(async () => result.current.requestBriefing('all'));

    expect(getVoiceBriefing).toHaveBeenCalledOnce();
    expect(getVoiceBriefing).toHaveBeenCalledWith('all');
    expect(speakOnce).not.toHaveBeenCalled();
    expect(result.current.briefing).toEqual(briefing);
    expect(result.current.phase).toBe('idle');
  });

  it('previews a stop without mutation and executes it exactly once after tapped confirmation', async () => {
    const refreshed = snapshot('The stop was requested.', 'stopping');
    vi.mocked(getVoiceBriefing)
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(refreshed);
    const stopRequest = deferred<Awaited<ReturnType<typeof stopTaskExecution>>>();
    vi.mocked(stopTaskExecution).mockReturnValue(stopRequest.promise);
    const { result } = renderHook(() => useVoiceBriefing());
    await act(async () => result.current.requestBriefing());

    await act(async () => result.current.handleTranscript('stop task one'));
    expect(result.current.phase).toBe('confirming');
    expect(result.current.pendingAction).toMatchObject({ action: 'stop' });
    expect(stopTaskExecution).not.toHaveBeenCalled();

    let firstConfirmation!: Promise<void>;
    await act(async () => {
      firstConfirmation = result.current.confirmPendingAction();
      await result.current.confirmPendingAction();
    });
    expect(result.current.phase).toBe('executing');
    expect(stopTaskExecution).toHaveBeenCalledOnce();
    expect(stopTaskExecution).toHaveBeenCalledWith('task-1');

    await act(async () => {
      stopRequest.resolve({ success: true, message: 'Stopping', containerStopped: true });
      await firstConfirmation;
    });
    expect(getVoiceBriefing).toHaveBeenCalledTimes(2);
    expect(result.current.briefing).toEqual(refreshed);
    expect(result.current.pendingAction).toBeNull();
  });

  it('uses a second spoken confirmation for one follow-up API call', async () => {
    const { result } = renderHook(() => useVoiceBriefing());
    await act(async () => result.current.requestBriefing());

    await act(async () => result.current.handleTranscript(
      'follow up task one to add a regression test',
    ));
    expect(postTaskFollowup).not.toHaveBeenCalled();
    expect(result.current.pendingAction).toMatchObject({
      action: 'follow_up',
      instruction: 'add a regression test',
    });

    await act(async () => result.current.handleTranscript('confirm'));

    expect(postTaskFollowup).toHaveBeenCalledOnce();
    expect(postTaskFollowup).toHaveBeenCalledWith('task-1', 'add a regression test');
    expect(getVoiceBriefing).toHaveBeenCalledTimes(2);
  });

  it('clears a pending action when cancelled without mutating the task', async () => {
    const { result } = renderHook(() => useVoiceBriefing());
    await act(async () => result.current.requestBriefing());
    await act(async () => result.current.handleTranscript('stop task one'));

    act(() => result.current.cancelPendingAction());

    expect(result.current.pendingAction).toBeNull();
    expect(result.current.phase).toBe('idle');
    expect(stopTaskExecution).not.toHaveBeenCalled();
    expect(postTaskFollowup).not.toHaveBeenCalled();
  });

  it('starts recognition only from the exposed action and resolves against the latest snapshot', async () => {
    const recognition = deferred<string>();
    vi.mocked(listenOnce).mockReturnValue(recognition.promise);
    const onOpenItem = vi.fn();
    const { result } = renderHook(() => useVoiceBriefing({ onOpenItem }));
    await act(async () => result.current.requestBriefing());
    expect(listenOnce).not.toHaveBeenCalled();

    let listening!: Promise<void>;
    act(() => {
      listening = result.current.startListening();
    });
    expect(listenOnce).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('listening');

    await act(async () => {
      recognition.resolve('open task one');
      await listening;
    });
    expect(onOpenItem).toHaveBeenCalledWith(result.current.briefing?.items[0]);
    expect(result.current.transcript).toBe('open task one');
  });

  it('aborts recognition and speech when the document is hidden or the hook unmounts', async () => {
    const speech = deferred<void>();
    const cancelSpeech = vi.fn(() => speech.resolve());
    vi.mocked(speakOnce).mockReturnValue({ promise: speech.promise, cancel: cancelSpeech });
    const { result, unmount } = renderHook(() => useVoiceBriefing());

    let request!: Promise<void>;
    act(() => {
      request = result.current.requestBriefing();
    });
    await act(async () => Promise.resolve());
    expect(result.current.phase).toBe('speaking');

    currentVisibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => request);
    expect(cancelSpeech).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('idle');

    const abortObserved = vi.fn();
    vi.mocked(listenOnce).mockImplementation(({ signal } = {}) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        abortObserved();
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }));
    currentVisibility = 'visible';
    act(() => { void result.current.startListening(); });
    unmount();
    expect(abortObserved).toHaveBeenCalledOnce();
  });

  it('does not create polling or delayed-refresh timers after a confirmed mutation', async () => {
    const interval = vi.spyOn(window, 'setInterval');
    const timeout = vi.spyOn(window, 'setTimeout');
    const { result } = renderHook(() => useVoiceBriefing());
    await act(async () => result.current.requestBriefing());
    await act(async () => result.current.handleTranscript('stop task one'));
    await act(async () => result.current.confirmPendingAction());

    expect(interval).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    expect(getVoiceBriefing).toHaveBeenCalledTimes(2);
  });
});
