import React from 'react';
import { Github } from 'lucide-react';
import { RepositoryIndexingStatus, MonitoredRepo } from '../api/proprApi';
import { getRepoStatusKey } from '../api/repoIndexingApi';

type RepoStatusType = 'indexed' | 'indexing' | 'failed' | 'idle';

// Status dot with pulsing animation for indexing
const StatusDot: React.FC<{ status: RepoStatusType; className?: string }> = ({ status, className = "" }) => {
  const dotColors = {
    indexed: 'bg-slate-400',
    indexing: 'bg-blue-500 animate-pulse',
    failed: 'bg-red-500',
    idle: 'bg-slate-300'
  };
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColors[status]} ${className}`} />;
};

// Calculate progress text for indexing status
const getProgressText = (status: RepositoryIndexingStatus): string => {
  const progress = status.progress;
  if (!progress) return 'Starting...';

  if (progress.phase === 'directories') {
    const dirPercent = progress.totalDirectories > 0
      ? Math.round((progress.processedDirectories / progress.totalDirectories) * 100)
      : 0;
    return `${dirPercent}%`;
  }
  return `${progress.percentComplete || 0}%`;
};

// Get status info from indexing status
const getStatusInfo = (status: RepositoryIndexingStatus | undefined): {
  statusType: RepoStatusType;
  statusText: string;
  progressText?: string;
} => {
  if (!status) {
    return { statusType: 'idle', statusText: 'Not indexed' };
  }

  switch (status.indexing_status) {
    case 'indexing':
      return { statusType: 'indexing', statusText: 'Indexing', progressText: getProgressText(status) };
    case 'completed':
      return { statusType: 'indexed', statusText: 'Indexed' };
    case 'failed':
      return { statusType: 'failed', statusText: 'Failed' };
    case 'idle':
    default:
      return { statusType: 'idle', statusText: 'Not indexed' };
  }
};

const getRepositoryListItemClassName = (isSelected: boolean) => (
  `border-b border-slate-100 cursor-pointer transition-colors relative group ${isSelected ? 'bg-[#F0FDFA]' : 'hover:bg-slate-50/50'}`
);

const getStatusTextClassName = (statusType: RepoStatusType) => {
  const colorClass = {
    indexed: 'text-slate-500',
    indexing: 'text-blue-600',
    failed: 'text-red-600',
    idle: 'text-slate-500'
  };

  return `inline-flex items-center gap-1.5 ${colorClass[statusType]}`;
};

interface RepositoryListItemProps {
  repo: MonitoredRepo;
  indexingStatuses: Record<string, RepositoryIndexingStatus>;
  isSelected?: boolean;
  onSelect?: (repoId: string) => void;
}

export const RepositoryListItem: React.FC<RepositoryListItemProps> = ({
  repo,
  indexingStatuses,
  isSelected = false,
  onSelect,
}) => {
  // Get indexing status for this repo
  const repoStatus = indexingStatuses[getRepoStatusKey(repo.name, repo.baseBranch)];
  const { statusType, statusText, progressText } = getStatusInfo(repoStatus);
  const itemClassName = getRepositoryListItemClassName(isSelected);
  const statusClassName = getStatusTextClassName(statusType);

  return (
    <div
      className={itemClassName}
      onClick={() => onSelect?.(repo.id)}
    >
      {isSelected && <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-teal-500" />}
      <div className={`space-y-1 px-4 py-3 ${repo.enabled ? 'opacity-100' : 'opacity-50'}`}>
        <div className="flex items-center gap-2 text-xs min-h-5">
          <span className={statusClassName}>
            <StatusDot status={statusType} />
            <span>{statusText}</span>
            {progressText && <span className="text-blue-500">({progressText})</span>}
          </span>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left font-semibold text-slate-800 rounded focus-visible:outline-teal-500"
            title={repo.alias ? `${repo.alias} (${repo.name})` : repo.name}
            aria-label={`Select ${repo.name}`}
            aria-pressed={isSelected}
          >
            {repo.alias || repo.name}
          </button>
          <a
            href={`https://github.com/${repo.name}`}
            target="_blank"
            rel="noopener noreferrer"
            className="p-0.5 text-slate-400 hover:text-slate-700 shrink-0"
            title="View on GitHub"
            onClick={(e) => e.stopPropagation()}
          >
            <Github className="w-3 h-3" />
          </a>
        </div>
      </div>
    </div>
  );
};
