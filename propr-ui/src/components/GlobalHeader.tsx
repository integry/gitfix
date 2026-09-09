import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import GlobalSearch from './GlobalSearch';
import QuickAddTodo from './QuickAddTodo';
import { useHeaderStats, type HeaderStats } from '../hooks/useHeaderStats';
import {
  SystemHealth,
  ActivePlansButton,
  TasksButton,
} from './GlobalHeaderComponents';
import type { CurrentUser } from '../api/proprTypes';
import MobileBottomNavigation from './MobileBottomNavigation';

interface GlobalHeaderProps {
  user: CurrentUser | null;
  onLogout: () => void;
  onMenuToggle: () => void;
  MenuIcon: React.FC<{ className?: string }>;
  isDemoMode?: boolean;
  headerStatsOverride?: Pick<HeaderStats, 'runningCount' | 'runningItems' | 'activePlans' | 'reviewGroups' | 'systemHealth'> & {
    activityStatus?: HeaderStats['activityStatus'];
    dismissPlan?: HeaderStats['dismissPlan'];
    dismissTask?: HeaderStats['dismissTask'];
  };
  newPlanPressedOverride?: boolean;
  inboxUnreadCount?: number | null;
}

function resolveHeaderStats(
  override: GlobalHeaderProps['headerStatsOverride'],
  stats: HeaderStats
) {
  return {
    runningCount: override?.runningCount ?? stats.runningCount,
    runningItems: override?.runningItems ?? stats.runningItems,
    activityStatus: override?.activityStatus ?? stats.activityStatus,
    activePlans: override?.activePlans ?? stats.activePlans,
    reviewGroups: override?.reviewGroups ?? stats.reviewGroups,
    systemHealth: override?.systemHealth ?? stats.systemHealth,
    dismissPlan: override?.dismissPlan ?? stats.dismissPlan,
    dismissTask: override?.dismissTask ?? stats.dismissTask,
  };
}

function useHeaderKeyboardShortcuts(
  searchInputRef: React.RefObject<HTMLInputElement | null>,
  setQuickAddOpen: React.Dispatch<React.SetStateAction<boolean>>
) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.altKey && e.key === 't') {
        e.preventDefault();
        setQuickAddOpen(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [searchInputRef, setQuickAddOpen]);
}

const GlobalHeader: React.FC<GlobalHeaderProps> = ({ user, onLogout, onMenuToggle, MenuIcon, isDemoMode = false, headerStatsOverride, newPlanPressedOverride = false, inboxUnreadCount = null }) => {
  const navigate = useNavigate();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  const headerStats = useHeaderStats();
  const { activePlans, reviewGroups, systemHealth, dismissPlan, dismissTask } = resolveHeaderStats(headerStatsOverride, headerStats);

  const handleNewPlan = useCallback(() => {
    if (isDemoMode) return;
    navigate('/studio/new');
  }, [isDemoMode, navigate]);

  useHeaderKeyboardShortcuts(searchInputRef, setQuickAddOpen);

  const newPlanBg = newPlanPressedOverride ? 'bg-teal-800' : 'bg-teal-600';
  const newPlanTitle = isDemoMode ? 'Demo mode is read-only' : 'New Plan';

  return (
    <>
    {/* Global navigation owns app-wide dropdowns, so its stacking context must stay
        above route-level sticky headers such as task details summaries. */}
    <header className="desktop-content-toolbar sticky top-0 z-40 hidden h-14 grid-cols-[minmax(0,1fr)_16rem_minmax(0,1fr)] items-stretch border-b border-slate-200 bg-slate-50 md:grid xl:grid-cols-[minmax(0,1fr)_20rem_minmax(0,1fr)]">
      <div className="flex min-w-0 items-stretch justify-self-start">
        <div className="flex items-center px-2 lg:hidden">
          <button
            onClick={onMenuToggle}
            className="p-2 text-gray-500 hover:text-gray-700"
            aria-label="Open menu"
          >
            <MenuIcon className="h-6 w-6" />
          </button>
        </div>
        <div className="flex items-stretch">
          <ActivePlansButton activePlans={activePlans} onDismissPlan={dismissPlan} />
          <div className="h-[60%] w-px self-center bg-slate-200" />
          <TasksButton taskGroups={reviewGroups} onDismissTask={dismissTask} />
        </div>
      </div>

      <div className="flex w-full items-center justify-center px-2">
        <div className="w-full">
          <GlobalSearch inputRef={searchInputRef} />
        </div>
      </div>

      <div className="flex items-stretch gap-2 justify-self-end pl-3">
        <div className="flex items-center">
          <QuickAddTodo
            externalOpen={quickAddOpen}
            onExternalOpenHandled={() => setQuickAddOpen(false)}
            disabled={isDemoMode}
          />
        </div>
        <div className="flex items-center">
          <button
            onClick={handleNewPlan}
            disabled={isDemoMode}
            title={newPlanTitle}
            className={`flex items-center gap-2 whitespace-nowrap rounded-lg border-0 px-3 py-1.5 text-white text-sm font-medium hover:bg-teal-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed xl:px-4 ${newPlanBg}`}
          >
            <ScrollText className="w-4 h-4" />
            <span>New Plan</span>
          </button>
        </div>
        <SystemHealth systemHealth={systemHealth} />
      </div>
    </header>
    <MobileBottomNavigation
      user={user}
      onLogout={onLogout}
      isDemoMode={isDemoMode}
      unreadCount={inboxUnreadCount}
      systemHealth={systemHealth}
    />
    </>
  );
};

export default GlobalHeader;
