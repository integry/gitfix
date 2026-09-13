import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueueStats, getSystemStatus, getTasks } from '../api/proprApi';
import { getDrafts } from '../api/plannerApi';
import { useHeaderStats } from './useHeaderStats';
import type { QueueStatsUpdatePayload } from '@propr/shared';

const socketState = vi.hoisted(() => ({
  isConnected: true,
  queueCallbacks: new Set<(payload: QueueStatsUpdatePayload) => void>(),
}));

vi.mock('../api/proprApi', () => ({
  getQueueStats: vi.fn(),
  getSystemStatus: vi.fn(),
  getTasks: vi.fn(),
}));

vi.mock('../api/plannerApi', () => ({ getDrafts: vi.fn() }));
vi.mock('../config/runtimeMode', () => ({ isDesktopRuntime: () => true }));
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: socketState.isConnected,
    onTaskUpdate: () => () => undefined,
    onDraftUpdate: () => () => undefined,
    onQueueStatsUpdate: (callback: (payload: QueueStatsUpdatePayload) => void) => {
      socketState.queueCallbacks.add(callback);
      return () => socketState.queueCallbacks.delete(callback);
    },
  }),
}));

const queueSnapshot = (activeJobs: Array<Record<string, unknown>>) => ({
  active: activeJobs.length,
  activeJobs,
  waiting: 0,
  delayed: 0,
  completed: 0,
  failed: 0,
  paused: 0,
});

const activeJob = {
  id: 'job-1',
  taskId: 'task-1',
  name: 'processGitHubIssue',
  title: 'Live implementation',
  repository: 'integry/propr',
  createdAt: '2026-09-09T08:00:00.000Z',
};

const queuePush = (active: number, completed = 0): QueueStatsUpdatePayload => ({
  eventType: 'queue:stats:update',
  stats: {
    active,
    activeGoals: 0,
    waiting: 0,
    delayed: 0,
    completed,
    failed: 0,
    total: active + completed,
  },
  timestamp: '2026-09-13T00:00:00.000Z',
});

const healthyStatus = {
  daemon: 'Running',
  workers: [{ id: 1, status: 'active' }],
  redis: 'Connected',
  githubAuth: 'Authenticated',
  claudeAuth: 'Ready',
  indexing: 'Idle',
  githubEventIntake: 'ProPR Connect',
  githubEventIntakeStatus: 'Connected',
  agents: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe('useHeaderStats desktop recovery', () => {
  beforeEach(() => {
    socketState.isConnected = true;
    socketState.queueCallbacks.clear();
    vi.mocked(getQueueStats).mockResolvedValue(queueSnapshot([activeJob]) as never);
    vi.mocked(getDrafts).mockResolvedValue({ drafts: [], total: 0, page: 1, limit: 20, hasMore: false });
    vi.mocked(getTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(getSystemStatus).mockResolvedValue(healthyStatus);
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('reconciles a successful completion to zero from the queue subscription', async () => {
    const { result } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(result.current.runningCount).toBe(1));
    expect(result.current.activityStatus).toBe('available');

    vi.mocked(getQueueStats).mockResolvedValue(queueSnapshot([]) as never);
    act(() => socketState.queueCallbacks.forEach(callback => callback(queuePush(0, 1))));

    await waitFor(() => expect(result.current.runningCount).toBe(0));
    expect(result.current.runningItems).toEqual([]);
    expect(result.current.activityStatus).toBe('available');
  });

  it('bounds identical periodic queue invalidations to one HTTP reconciliation', async () => {
    renderHook(() => useHeaderStats());
    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(1));

    const payload = queuePush(1);
    act(() => {
      socketState.queueCallbacks.forEach(callback => {
        callback(payload);
        callback({ ...payload, timestamp: '2026-09-13T00:00:05.000Z' });
        callback({ ...payload, timestamp: '2026-09-13T00:00:10.000Z' });
      });
    });

    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(2));
    expect(getDrafts).toHaveBeenCalledTimes(2);
    expect(getTasks).toHaveBeenCalledTimes(2);
    expect(getSystemStatus).toHaveBeenCalledTimes(2);

    act(() => socketState.queueCallbacks.forEach(callback => callback({
      ...payload,
      timestamp: '2026-09-13T00:00:15.000Z',
    })));
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(getQueueStats).toHaveBeenCalledTimes(2);
    expect(getDrafts).toHaveBeenCalledTimes(2);
    expect(getTasks).toHaveBeenCalledTimes(2);
    expect(getSystemStatus).toHaveBeenCalledTimes(2);
  });

  it('invalidates activity during a real transport outage and automatically recovers', async () => {
    const { result, rerender } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(result.current.runningCount).toBe(1));

    socketState.isConnected = false;
    rerender();
    expect(result.current.activityStatus).toBe('unavailable');
    expect(result.current.runningCount).toBe(0);
    expect(result.current.runningItems).toEqual([]);

    const recovered = deferred<ReturnType<typeof queueSnapshot>>();
    vi.mocked(getQueueStats).mockReturnValueOnce(recovered.promise as never);
    socketState.isConnected = true;
    rerender();
    expect(result.current.activityStatus).toBe('checking');

    await act(async () => recovered.resolve(queueSnapshot([])));
    await waitFor(() => expect(result.current.activityStatus).toBe('available'));
    expect(result.current.runningCount).toBe(0);
    expect(getQueueStats).toHaveBeenCalledTimes(2);
  });
});
