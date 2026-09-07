/* eslint-disable max-lines -- controller lifecycle regressions share one focused fixture */
import { act, renderHook, waitFor } from '@testing-library/react';
import { voiceBriefingResponseSchema, type VoiceBriefingResponse } from '@propr/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortGeneration,
  abortRefinement,
  getDraftWithPlan,
  postTaskFollowup,
  refinePlan,
  stopTaskExecution,
} from '../api/proprApi';
import { getVoiceBriefing } from '../api/voiceApi';
import {
  getBrowserSpeechCapabilities,
  listenOnce,
  speakOnce,
} from '../voice/browserSpeech';
import { useVoiceBriefing } from './useVoiceBriefing';

let currentVisibility: DocumentVisibilityState = 'visible';

vi.mock('../api/proprApi', () => ({
  abortGeneration: vi.fn(),
  abortRefinement: vi.fn(),
  getDraftWithPlan: vi.fn(),
  postTaskFollowup: vi.fn(),
  refinePlan: vi.fn(),
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
  taskId = 'task-1',
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
      id: taskId,
      title: 'Voice controller',
      repository: 'integry/propr',
      status,
      summary: 'Waiting for a decision.',
      href: `/tasks/${taskId}`,
      requiresAttention: true,
      actions: ['open', 'stop', 'follow_up'],
      updatedAt: '2026-09-07T09:30:00.000Z',
    }],
  });
}

function planSnapshot(
  status: 'generating' | 'refining' | 'executing' | 'review',
): VoiceBriefingResponse {
  const action = status === 'review' ? 'follow_up' : 'stop';
  return voiceBriefingResponseSchema.parse({
    generatedAt: '2026-09-07T09:35:00.000Z',
    scope: 'all',
    headline: 'One plan needs attention',
    speechText: 'One plan needs attention.',
    counts: { running: 0, queued: 0, attention: status === 'review' ? 1 : 0, plans: 1, total: 1 },
    items: [{
      reference: 'plan 1',
      position: 1,
      kind: 'plan',
      id: 'draft-1',
      title: 'Plan for integry/propr',
      repository: 'integry/propr',
      status,
      summary: `Plan for integry/propr is ${status}.`,
      href: '/studio/draft-1',
      requiresAttention: status === 'review',
      actions: ['open', action],
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
    vi.mocked(abortGeneration).mockResolvedValue();
    vi.mocked(abortRefinement).mockResolvedValue();
    vi.mocked(refinePlan).mockResolvedValue({ plan: [], message: 'Refinement started' });
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

  it.each([
    ['generating', abortGeneration],
    ['refining', abortRefinement],
  ] as const)('confirms and stops a %s plan through its planner operation', async (status, stopPlan) => {
    vi.mocked(getVoiceBriefing).mockResolvedValue(planSnapshot(status));
    const { result } = renderHook(() => useVoiceBriefing());
    await act(async () => result.current.requestBriefing());

    await act(async () => result.current.handleTranscript('stop plan one'));

    expect(result.current.phase).toBe('confirming');
    expect(result.current.pendingAction).toMatchObject({ action: 'stop' });
    expect(stopPlan).not.toHaveBeenCalled();

    await act(async () => result.current.confirmPendingAction());

    expect(stopPlan).toHaveBeenCalledOnce();
    expect(stopPlan).toHaveBeenCalledWith('draft-1');
    expect(stopTaskExecution).not.toHaveBeenCalled();
    expect(postTaskFollowup).not.toHaveBeenCalled();
  });

  it('rejects an executing plan stop when the briefing has no execution identifier', async () => {
    vi.mocked(getVoiceBriefing).mockResolvedValue(planSnapshot('executing'));
    const { result } = renderHook(() => useVoiceBriefing());
    await act(async () => result.current.requestBriefing());
    await act(async () => result.current.handleTranscript('stop plan one'));

    await act(async () => result.current.confirmPendingAction());

    expect(result.current.phase).toBe('error');
    expect(result.current.error).toBe(
      'Cannot stop plan 1 because the briefing does not identify its task execution.',
    );
    expect(abortGeneration).not.toHaveBeenCalled();
    expect(abortRefinement).not.toHaveBeenCalled();
    expect(stopTaskExecution).not.toHaveBeenCalled();
    expect(getVoiceBriefing).toHaveBeenCalledOnce();
  });

  it('confirms a plan follow-up and starts refinement with the current plan', async () => {
    const currentPlan = [{
      id: 'step-1',
      title: 'Test the controller',
      body: 'Add regression coverage.',
      implementation: 'Update the hook tests.',
    }];
    vi.mocked(getVoiceBriefing).mockResolvedValue(planSnapshot('review'));
    vi.mocked(getDraftWithPlan).mockResolvedValue({
      plan_json: currentPlan,
    } as Awaited<ReturnType<typeof getDraftWithPlan>>);
    const { result } = renderHook(() => useVoiceBriefing());
    await act(async () => result.current.requestBriefing());

    await act(async () => result.current.handleTranscript(
      'follow up plan one to rerun the tests',
    ));

    expect(result.current.phase).toBe('confirming');
    expect(result.current.pendingAction).toMatchObject({
      action: 'follow_up',
      instruction: 'rerun the tests',
    });
    expect(refinePlan).not.toHaveBeenCalled();

    await act(async () => result.current.confirmPendingAction());

    expect(getDraftWithPlan).toHaveBeenCalledWith('draft-1');
    expect(refinePlan).toHaveBeenCalledWith(
      'draft-1',
      currentPlan,
      'rerun the tests',
    );
    expect(stopTaskExecution).not.toHaveBeenCalled();
    expect(postTaskFollowup).not.toHaveBeenCalled();
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

  it('does not start recognition while the document is already hidden', async () => {
    const { result } = renderHook(() => useVoiceBriefing());
    await act(async () => result.current.requestBriefing());
    await act(async () => result.current.handleTranscript('stop task one'));
    expect(result.current.phase).toBe('confirming');

    currentVisibility = 'hidden';
    await act(async () => result.current.startListening());

    expect(listenOnce).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('confirming');
  });

  it('cancels active recognition before repeating the briefing', async () => {
    const abortObserved = vi.fn();
    vi.mocked(listenOnce).mockImplementation(({ signal } = {}) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        abortObserved();
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }));
    const { result } = renderHook(() => useVoiceBriefing());
    await act(async () => result.current.requestBriefing());

    let listening!: Promise<void>;
    act(() => {
      listening = result.current.startListening();
    });
    expect(result.current.phase).toBe('listening');

    await act(async () => {
      await result.current.repeatBriefing();
      await listening;
    });

    expect(abortObserved).toHaveBeenCalledOnce();
    expect(speakOnce).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe('idle');
  });

  it('stops current speech and suppresses speech from an abandoned request', async () => {
    const activeRequest = deferred<VoiceBriefingResponse>();
    vi.mocked(getVoiceBriefing).mockReturnValue(activeRequest.promise);
    const { result } = renderHook(() => useVoiceBriefing());

    let request!: Promise<void>;
    act(() => {
      request = result.current.requestBriefing();
    });
    act(() => result.current.stopAudio());

    await act(async () => {
      activeRequest.resolve(snapshot());
      await request;
    });

    expect(speakOnce).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
  });

  it('waits for an active briefing request before processing a destructive command', async () => {
    const activeRequest = deferred<VoiceBriefingResponse>();
    const current = snapshot('Task two is now current.', 'running', 'task-2');
    const refreshed = snapshot('Task two is stopping.', 'stopping', 'task-2');
    vi.mocked(getVoiceBriefing)
      .mockResolvedValueOnce(snapshot())
      .mockReturnValueOnce(activeRequest.promise)
      .mockResolvedValueOnce(refreshed);
    const { result } = renderHook(() => useVoiceBriefing());
    await act(async () => result.current.requestBriefing());

    let request!: Promise<void>;
    act(() => {
      request = result.current.requestBriefing();
    });
    await act(async () => result.current.handleTranscript('stop task one'));
    expect(result.current.pendingAction).toBeNull();
    expect(stopTaskExecution).not.toHaveBeenCalled();

    await act(async () => {
      activeRequest.resolve(current);
      await request;
    });
    await act(async () => result.current.handleTranscript('stop task one'));
    await act(async () => result.current.confirmPendingAction());

    expect(stopTaskExecution).toHaveBeenCalledOnce();
    expect(stopTaskExecution).toHaveBeenCalledWith('task-2');
    expect(result.current.briefing).toEqual(refreshed);
  });

  it('recognizes commands from the latest snapshot while an older request remains unresolved', async () => {
    const olderRequest = deferred<VoiceBriefingResponse>();
    const newerRequest = deferred<VoiceBriefingResponse>();
    const recognition = deferred<string>();
    const current = snapshot('Task three is now current.', 'running', 'task-3');
    vi.mocked(getVoiceBriefing)
      .mockResolvedValueOnce(snapshot())
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(newerRequest.promise);
    vi.mocked(listenOnce).mockReturnValue(recognition.promise);
    const onOpenItem = vi.fn();
    const { result } = renderHook(() => useVoiceBriefing({ onOpenItem }));
    await act(async () => result.current.requestBriefing());

    let older!: Promise<void>;
    let newer!: Promise<void>;
    act(() => {
      older = result.current.requestBriefing();
      newer = result.current.requestBriefing();
    });

    await act(async () => {
      newerRequest.resolve(current);
      await newer;
    });
    expect(result.current.phase).toBe('idle');

    let listening!: Promise<void>;
    act(() => {
      listening = result.current.startListening();
    });
    expect(result.current.phase).toBe('listening');

    await act(async () => {
      recognition.resolve('open task one');
      await listening;
    });
    expect(onOpenItem).toHaveBeenCalledWith(current.items[0]);
    expect(result.current.phase).toBe('idle');

    await act(async () => {
      olderRequest.resolve(snapshot('Stale task two.', 'running', 'task-2'));
      await older;
    });
    expect(result.current.briefing).toEqual(current);
    expect(result.current.phase).toBe('idle');
  });

  it('moves to an error state when a recognized command callback throws', async () => {
    vi.mocked(listenOnce).mockResolvedValue('open task one');
    const onOpenItem = vi.fn(() => {
      throw new Error('Navigation failed.');
    });
    const { result } = renderHook(() => useVoiceBriefing({ onOpenItem }));
    await act(async () => result.current.requestBriefing());

    await act(async () => result.current.startListening());

    expect(onOpenItem).toHaveBeenCalledOnce();
    expect(result.current.transcript).toBe('open task one');
    expect(result.current.error).toBe('Navigation failed.');
    expect(result.current.phase).toBe('error');
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

  it('settles to idle when the document is hidden during refreshed speech', async () => {
    const refreshedSpeech = deferred<void>();
    const cancelRefreshedSpeech = vi.fn(() => refreshedSpeech.resolve());
    vi.mocked(speakOnce)
      .mockReturnValueOnce({ promise: Promise.resolve(), cancel: vi.fn() })
      .mockReturnValueOnce({ promise: Promise.resolve(), cancel: vi.fn() })
      .mockReturnValueOnce({
        promise: refreshedSpeech.promise,
        cancel: cancelRefreshedSpeech,
      });
    vi.mocked(getVoiceBriefing)
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot('The stop was requested.', 'stopping'));
    const { result } = renderHook(() => useVoiceBriefing());
    await act(async () => result.current.requestBriefing());
    await act(async () => result.current.handleTranscript('stop task one'));

    let confirmation!: Promise<void>;
    act(() => {
      confirmation = result.current.confirmPendingAction();
    });
    await waitFor(() => expect(result.current.phase).toBe('speaking'));

    currentVisibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => confirmation);

    expect(cancelRefreshedSpeech).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('idle');
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
