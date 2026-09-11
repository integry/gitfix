import React, { useState } from 'react';
import { Github, RefreshCw, Star, Eye, EyeOff } from 'lucide-react';
import { DeleteRepoDialog } from './DeleteRepoDialog';
import { RepositoryIndexingStatus, MonitoredRepo } from '../api/proprApi';
import { getRepoStatusKey } from '../api/repoIndexingApi';

type RepoStatusType = 'indexed' | 'indexing' | 'failed' | 'idle';

// --- Icons ---

const TrashIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

// Monospace Code Chip for commit hash
const MonoCodeChip: React.FC<{ children: React.ReactNode; href?: string }> = ({ children, href }) => {
  const baseClass = "text-[12px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded";
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${baseClass} hover:bg-slate-200 hover:text-slate-700 transition-colors`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </a>
    );
  }
  return <code className={baseClass}>{children}</code>;
};

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

// Helper to format relative time
const formatRelativeTime = (timestamp: string | null): string => {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
};

// Helper to shorten commit hash
const shortenHash = (hash: string | null): string => {
  if (!hash) return '';
  return hash.substring(0, 7);
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

// Action buttons component to reduce complexity
const RepositoryActionButtons: React.FC<{
  repo: MonitoredRepo;
  statusType: RepoStatusType;
  onToggle: (repoId: string) => void;
  onReindex: (repoName: string, baseBranch?: string) => void;
  onDeleteClick: () => void;
  onToggleStar: (repoId: string) => void;
  onToggleHidden: (repoId: string) => void;
  isReadOnly?: boolean;
  isSelected: boolean;
}> = ({ repo, statusType, onToggle, onReindex, onDeleteClick, onToggleStar, onToggleHidden, isReadOnly = false, isSelected }) => (
  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
    <div className={`flex items-center ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'}`}>
      {/* Star Button */}
      <button
        onClick={() => onToggleStar(repo.id)}
        disabled={isReadOnly}
        className={`p-1.5 rounded transition-colors ${
          repo.starred
            ? 'text-amber-500 hover:text-amber-600 hover:bg-amber-50'
            : 'text-slate-300 hover:text-amber-500 hover:bg-amber-50'
        }`}
        title={repo.starred ? 'Unstar repository' : 'Star repository'}
      >
        <Star className={`w-3.5 h-3.5 ${repo.starred ? 'fill-current' : ''}`} />
      </button>

      {/* Hide/Unhide Button */}
      <button
        onClick={() => onToggleHidden(repo.id)}
        disabled={isReadOnly}
        className={`p-1.5 rounded transition-colors ${
          repo.hidden
            ? 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
            : 'text-slate-300 hover:text-slate-500 hover:bg-slate-100'
        }`}
        title={repo.hidden ? 'Unhide repository' : 'Hide repository'}
      >
        {repo.hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>

      {/* Reindex Button - Gray ghost style */}
      <button
        onClick={() => onReindex(repo.name, repo.baseBranch)}
        className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors"
        title="Reindex Repository"
        disabled={statusType === 'indexing' || isReadOnly}
      >
        <RefreshCw className={`w-3.5 h-3.5 ${statusType === 'indexing' ? 'animate-spin opacity-50' : ''}`} />
      </button>

      {/* Remove repository */}
      <button
        onClick={onDeleteClick}
        disabled={isReadOnly}
        className="p-1.5 text-slate-300 hover:text-red-600 hover:bg-red-50 rounded transition-all"
        title="Remove repository"
      >
        <TrashIcon className="w-3.5 h-3.5" />
      </button>
    </div>
    {/* Toggle Switch */}
    <label className="relative inline-flex items-center cursor-pointer">
      <input
        type="checkbox"
        aria-label={`Monitor ${repo.name}`}
        checked={repo.enabled}
        onChange={() => onToggle(repo.id)}
        disabled={isReadOnly}
        className="sr-only peer"
      />
      <div className="w-7 h-4 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-teal-500/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-teal-500"></div>
    </label>
  </div>
);

interface RepositoryListItemProps {
  repo: MonitoredRepo;
  indexingStatuses: Record<string, RepositoryIndexingStatus>;
  onToggle: (repoId: string) => void;
  onRemove: (repoId: string) => void | Promise<void>;
  onStopIndexing: (repoName: string, baseBranch?: string) => void;
  onReindex: (repoName: string, baseBranch?: string) => void;
  onToggleStar: (repoId: string) => void;
  onToggleHidden: (repoId: string) => void;
  isSelected?: boolean;
  onSelect?: (repoId: string) => void;
  isReadOnly?: boolean;
}

export const RepositoryListItem: React.FC<RepositoryListItemProps> = ({
  repo,
  indexingStatuses,
  onToggle,
  onRemove,
  onStopIndexing,
  onReindex,
  onToggleStar,
  onToggleHidden,
  isSelected = false,
  onSelect,
  isReadOnly = false,
}) => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteClick = () => {
    if (isReadOnly) return;
    setIsDeleteDialogOpen(true);
  };

  const handleDeleteClose = () => {
    setIsDeleteDialogOpen(false);
  };

  const handleDeleteConfirm = async () => {
    setIsDeleting(true);
    try {
      await onRemove(repo.id);
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  // Get indexing status for this repo
  const repoStatus = indexingStatuses[getRepoStatusKey(repo.name, repo.baseBranch)];
  const { statusType, statusText, progressText } = getStatusInfo(repoStatus);
  const shortHash = shortenHash(repoStatus?.last_indexed_hash);
  const relativeTime = formatRelativeTime(repoStatus?.last_indexed_at);
  const commitUrl = repoStatus?.full_name && repoStatus?.last_indexed_hash
    ? `https://github.com/${repoStatus.full_name}/commit/${repoStatus.last_indexed_hash}`
    : undefined;
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
          {shortHash && <MonoCodeChip href={commitUrl}>{shortHash}</MonoCodeChip>}
          <span className={statusClassName}>
            <StatusDot status={statusType} />
            <span>{statusText}</span>
            {progressText && <span className="text-blue-500">({progressText})</span>}
          </span>
          {statusType === 'indexing' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onStopIndexing(repo.name, repo.baseBranch);
              }}
              disabled={isReadOnly}
              className="text-red-500 hover:text-red-700 rounded"
              title="Stop Indexing"
            >
              Stop
            </button>
          )}
          {relativeTime && statusType === 'indexed' && (
            <span className="ml-auto whitespace-nowrap text-slate-500">{relativeTime}</span>
          )}
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
          <RepositoryActionButtons
            repo={repo}
            statusType={statusType}
            onToggle={onToggle}
            onReindex={onReindex}
            onDeleteClick={handleDeleteClick}
            onToggleStar={onToggleStar}
            onToggleHidden={onToggleHidden}
            isReadOnly={isReadOnly}
            isSelected={isSelected}
          />
        </div>
      </div>

      <DeleteRepoDialog
        isOpen={isDeleteDialogOpen}
        repoName={repo.name}
        onClose={handleDeleteClose}
        onConfirm={handleDeleteConfirm}
        isLoading={isDeleting}
      />
    </div>
  );
};
