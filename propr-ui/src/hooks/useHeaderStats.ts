import { useState, useEffect, useCallback, useRef } from 'react';
import { getQueueStats, getTasks, getSystemStatus } from '../api/proprApi';
import { getDrafts, DraftListItem } from '../api/plannerApi';
import { useSocket } from '../contexts/useSocket';
import { isDesktopRuntime } from '../config/runtimeMode';
import type { QueueStatsUpdatePayload } from '@propr/shared';
import {
  buildReviewGroups,
  buildRunningItems,
  buildSystemHealth,
  DISMISSED_PLAN_IDS_KEY,
  DISMISSED_TASK_IDS_KEY,
  filterActivePlans,
  getDismissedIds,
  getDismissedTaskTimestamps,
  saveDismissedIds,
  saveDismissedTaskTimestamps,
} from './useHeaderStatsHelpers';
import type {
  DismissedTaskTimestamps,
  RunningItem,
  SystemHealth,
  TaskGroup,
} from './useHeaderStatsHelpers';

export type { RunningItem } from './useHeaderStatsHelpers';

const LIVE_INVALIDATION_COALESCE_MS = 100;

const queueStatsFingerprint = (payload: QueueStatsUpdatePayload): string => JSON.stringify([
  payload.stats.waiting,
  payload.stats.active,
  payload.stats.activeGoals ?? 0,
  payload.stats.completed,
  payload.stats.failed,
  payload.stats.delayed,
  payload.stats.total,
]);

export interface HeaderStats {
  // Running tasks count from queue
  runningCount: number;

  // Running items for AI Activity Monitor dropdown
  runningItems: RunningItem[];

  // Whether the active-work snapshot is current and complete.
  activityStatus: 'checking' | 'available' | 'unavailable';

  // Active plans (not merged, not closed), sorted by updated_at descending
  activePlans: DraftListItem[];

  // Review items count (actionable tasks)
  reviewCount: number;

  // Review task groups for dropdown display
  reviewGroups: TaskGroup[];

  // System health status
  systemHealth: SystemHealth;

  // Loading states
  isLoading: boolean;

  // Error state
  error: string | null;

  // Dismissal functions
  dismissPlan: (planId: string) => void;
  // Dismiss a task group - stores timestamp to auto-dismiss older followup tasks
  dismissTask: (taskGroupKey: string, latestTaskCreatedAt: string) => void;

  // Get dismissed IDs
  dismissedPlanIds: string[];
  dismissedTaskIds: string[];

  // Clear all dismissals
  clearDismissedPlans: () => void;
  clearDismissedTasks: () => void;

  // Refresh function
  refresh: () => Promise<void>;
}

export function useHeaderStats(): HeaderStats {
  const [runningCount, setRunningCount] = useState<number>(0);
  const [runningItems, setRunningItems] = useState<RunningItem[]>([]);
  const [activityStatus, setActivityStatus] = useState<HeaderStats['activityStatus']>('checking');
  const [activePlans, setActivePlans] = useState<DraftListItem[]>([]);
  const [reviewCount, setReviewCount] = useState<number>(0);
  const [reviewGroups, setReviewGroups] = useState<TaskGroup[]>([]);
  const [systemHealth, setSystemHealth] = useState<SystemHealth>({
    daemon: 'Unknown',
    workers: 'Unknown',
    redis: 'Unknown',
    githubAuth: 'Unknown',
    claudeAuth: 'Unknown',
    indexing: 'Unknown',
    githubEventIntake: 'Unknown',
    githubEventIntakeStatus: 'Unknown',
    agents: [],
    isHealthy: false,
  });
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Dismissed IDs state
  const [dismissedPlanIds, setDismissedPlanIds] = useState<string[]>(() => getDismissedIds(DISMISSED_PLAN_IDS_KEY));
  const [dismissedTaskIds, setDismissedTaskIds] = useState<string[]>(() => getDismissedIds(DISMISSED_TASK_IDS_KEY));
  // Track dismissal timestamps per PR/issue key for auto-dismissing older followup tasks
  const [dismissedTaskTimestamps, setDismissedTaskTimestamps] = useState<DismissedTaskTimestamps>(() => getDismissedTaskTimestamps());

  // Track if component is mounted
  const isMountedRef = useRef(true);
  const statsRequestRef = useRef(0);
  const liveRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueueStatsFingerprintRef = useRef<string | null>(null);

  // WebSocket connection for real-time updates
  const { onTaskUpdate, onDraftUpdate, onQueueStatsUpdate, isConnected } = useSocket();
  const socketConnectedRef = useRef(isConnected);
  socketConnectedRef.current = isConnected;

  // Dismiss a plan
  const dismissPlan = useCallback((planId: string) => {
    setDismissedPlanIds(prev => {
      const newIds = [...prev, planId];
      saveDismissedIds(DISMISSED_PLAN_IDS_KEY, newIds);
      return newIds;
    });
  }, []);

  // Dismiss a task group - stores both the task ID and a timestamp for the PR/issue key
  // This ensures older followup tasks are automatically dismissed
  const dismissTask = useCallback((taskGroupKey: string, latestTaskCreatedAt: string) => {
    // Store the timestamp for this PR/issue key
    // Any tasks created at or before this timestamp for this key will be auto-dismissed
    const dismissTimestamp = new Date(latestTaskCreatedAt).getTime();

    setDismissedTaskTimestamps(prev => {
      const newTimestamps = { ...prev, [taskGroupKey]: dismissTimestamp };
      saveDismissedTaskTimestamps(newTimestamps);
      return newTimestamps;
    });

    // Also store the task group key in dismissedTaskIds for backwards compatibility
    setDismissedTaskIds(prev => {
      const newIds = [...prev, taskGroupKey];
      saveDismissedIds(DISMISSED_TASK_IDS_KEY, newIds);
      return newIds;
    });
  }, []);

  // Clear all dismissed plans
  const clearDismissedPlans = useCallback(() => {
    setDismissedPlanIds([]);
    saveDismissedIds(DISMISSED_PLAN_IDS_KEY, []);
  }, []);

  // Clear all dismissed tasks (including timestamps)
  const clearDismissedTasks = useCallback(() => {
    setDismissedTaskIds([]);
    saveDismissedIds(DISMISSED_TASK_IDS_KEY, []);
    setDismissedTaskTimestamps({});
    saveDismissedTaskTimestamps({});
  }, []);

  // Main fetch function
  const fetchStats = useCallback(async (isInitialLoad = false) => {
    const request = ++statsRequestRef.current;
    try {
      if (isInitialLoad) {
        setIsLoading(true);
      }

      // Fetch all data in parallel. Queue failure is isolated so unrelated
      // generating/refining plan activity can still be represented.
      const [queueResult, [draftsResponse, tasksResponse, statusResponse]] = await Promise.all([
        getQueueStats().then(
          value => ({ activeJobs: value.activeJobs || [], errorMessage: null }),
          error => ({ activeJobs: [], errorMessage: (error as Error).message })
        ),
        Promise.all([
          // Fetch active plans only (exclude merged at DB level - include executed and pr_created for Plans in Focus)
          getDrafts({ limit: 20, excludeStatuses: 'merged' }),
          // Fetch review-worthy tasks only (completed/failed, exclude merged at DB level)
          getTasks({ limit: 30, forReview: true, excludeMerged: true }),
          getSystemStatus(),
        ]),
      ]);

      if (!isMountedRef.current || request !== statsRequestRef.current) return;

      // Build running activity from generating/refining plans and authoritative
      // active queue jobs. Waiting and delayed jobs are intentionally excluded.
      const runningItemsList = buildRunningItems(
        draftsResponse.drafts,
        queueResult.activeJobs
      );

      setRunningItems(runningItemsList);
      // Running count should match the actual running items to ensure consistency
      setRunningCount(runningItemsList.length);
      setActivityStatus(queueResult.errorMessage
        || (isDesktopRuntime() && !socketConnectedRef.current)
        ? 'unavailable'
        : 'available');

      setActivePlans(filterActivePlans(draftsResponse.drafts));

      const reviewableGroups = buildReviewGroups(tasksResponse);
      setReviewGroups(reviewableGroups);
      setReviewCount(reviewableGroups.length);

      setSystemHealth(buildSystemHealth(statusResponse));

      setError(queueResult.errorMessage);
    } catch (err) {
      if (!isMountedRef.current || request !== statsRequestRef.current) return;
      console.error('Failed to fetch header stats:', err);
      setRunningItems([]);
      setRunningCount(0);
      setActivityStatus('unavailable');
      setError((err as Error).message);
    } finally {
      if (isMountedRef.current && request === statsRequestRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // Refresh function for manual refresh
  const refresh = useCallback(async () => {
    await fetchStats(false);
  }, [fetchStats]);

  // Queue, task, and draft transitions are often emitted together. Treat them
  // as invalidations and reconcile one authoritative snapshot after the burst
  // instead of starting overlapping copies of the same five HTTP reads.
  const scheduleLiveRefresh = useCallback(() => {
    if (liveRefreshTimerRef.current !== null) return;
    liveRefreshTimerRef.current = setTimeout(() => {
      liveRefreshTimerRef.current = null;
      void fetchStats(false);
    }, LIVE_INVALIDATION_COALESCE_MS);
  }, [fetchStats]);

  // In the desktop app, the scoped socket is the live lifecycle signal. A
  // disconnect invalidates cached activity immediately; reconnecting performs
  // a fresh authoritative snapshot without changing the saved profile or auth.
  const previousSocketConnectionRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const previous = previousSocketConnectionRef.current;
    previousSocketConnectionRef.current = isConnected;
    if (!isConnected) {
      if (liveRefreshTimerRef.current !== null) {
        clearTimeout(liveRefreshTimerRef.current);
        liveRefreshTimerRef.current = null;
      }
      statsRequestRef.current += 1;
      setRunningItems([]);
      setRunningCount(0);
      setActivityStatus('unavailable');
      setIsLoading(false);
      return;
    }
    if (previous === false) {
      setActivityStatus('checking');
      void fetchStats(false);
    }
  }, [fetchStats, isConnected]);

  // Initial load
  useEffect(() => {
    isMountedRef.current = true;

    // Initial fetch
    fetchStats(true);

    return () => {
      isMountedRef.current = false;
      if (liveRefreshTimerRef.current !== null) {
        clearTimeout(liveRefreshTimerRef.current);
        liveRefreshTimerRef.current = null;
      }
    };
  }, [fetchStats]);

  // Subscribe to WebSocket events for real-time updates
  useEffect(() => {
    if (!isConnected) return;

    // Handle task updates - refresh stats when any task changes state
    const handleTaskUpdate = () => {
      console.log('[useHeaderStats] Received task update, scheduling stats refresh');
      scheduleLiveRefresh();
    };

    // Handle draft updates - refresh stats when drafts change (affects active plans)
    const handleDraftUpdate = () => {
      console.log('[useHeaderStats] Received draft update, scheduling stats refresh');
      scheduleLiveRefresh();
    };

    const handleQueueStatsUpdate = (payload: QueueStatsUpdatePayload) => {
      const fingerprint = queueStatsFingerprint(payload);
      if (fingerprint === lastQueueStatsFingerprintRef.current) return;
      lastQueueStatsFingerprintRef.current = fingerprint;
      console.log('[useHeaderStats] Received changed queue stats, scheduling stats refresh');
      scheduleLiveRefresh();
    };

    // Subscribe to every event that can change active work.
    const unsubscribeTask = onTaskUpdate(handleTaskUpdate);
    const unsubscribeDraft = onDraftUpdate(handleDraftUpdate);
    const unsubscribeQueueStats = onQueueStatsUpdate(handleQueueStatsUpdate);

    return () => {
      unsubscribeTask();
      unsubscribeDraft();
      unsubscribeQueueStats();
    };
  }, [isConnected, onTaskUpdate, onDraftUpdate, onQueueStatsUpdate, scheduleLiveRefresh]);

  // Re-filter when dismissed IDs or timestamps change
  useEffect(() => {
    // Trigger a refresh when dismissal state changes
    // This ensures the lists are updated when items are dismissed
    if (!isLoading) {
      fetchStats(false);
    }
  }, [dismissedPlanIds.length, dismissedTaskIds.length, Object.keys(dismissedTaskTimestamps).length]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    runningCount,
    runningItems,
    activityStatus,
    activePlans,
    reviewCount,
    reviewGroups,
    systemHealth,
    isLoading,
    error,
    dismissPlan,
    dismissTask,
    dismissedPlanIds,
    dismissedTaskIds,
    clearDismissedPlans,
    clearDismissedTasks,
    refresh,
  };
}
