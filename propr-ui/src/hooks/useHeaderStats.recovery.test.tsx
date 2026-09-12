import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueueStats, getSystemStatus, getTasks } from '../api/proprApi';
import { getDrafts } from '../api/plannerApi';
import { useHeaderStats } from './useHeaderStats';

const socketState = vi.hoisted(() => ({
  isConnected: true,
  queueCallbacks: new Set<() => void>(),
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
    onQueueStatsUpdate: (callback: () => void) => {
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
    act(() => socketState.queueCallbacks.forEach(callback => callback()));

    await waitFor(() => expect(result.current.runningCount).toBe(0));
    expect(result.current.runningItems).toEqual([]);
    expect(result.current.activityStatus).toBe('available');
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
