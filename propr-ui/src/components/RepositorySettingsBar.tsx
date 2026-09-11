import React, { useState } from 'react';
import { RefreshCw, Square, Trash2 } from 'lucide-react';
import type { MonitoredRepo, RepositoryIndexingStatus } from '../api/proprApi';
import { RepositoryVisualPreviewControl, type RepositoryVisualPreviewSettings } from './RepositoryVisualPreviewControl';
import { IndexingStatusIndicator } from './IndexingStatusIndicator';
import { DeleteRepoDialog } from './DeleteRepoDialog';

const AutoCiFollowupControl: React.FC<{
  repo: MonitoredRepo;
  onToggle: (repoId: string) => void;
  isReadOnly: boolean;
}> = ({ repo, onToggle, isReadOnly }) => {
  if (isReadOnly) return null;

  return (
    <label
      className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-slate-600 cursor-pointer"
      title="Automatically create follow-up work when CI fails"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={repo.autoFollowupOnFailedCi === true}
        onChange={() => onToggle(repo.id)}
        className="sr-only peer"
        aria-label={`Automatic CI follow-up for ${repo.name}`}
      />
      <span className="relative w-7 h-4 bg-slate-200 rounded-full peer-focus:ring-2 peer-focus:ring-teal-500/20 peer-checked:bg-teal-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:h-3 after:w-3 after:rounded-full after:bg-white after:border after:border-slate-300 after:transition-all peer-checked:after:translate-x-full" />
      <span>Auto CI follow-up</span>
      <span className={`rounded px-1.5 py-0.5 font-medium ${repo.autoFollowupOnFailedCi ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-500'}`}>
        {repo.autoFollowupOnFailedCi ? 'On' : 'Off'}
      </span>
    </label>
  );
};

interface RepositorySettingsBarProps {
  repo: MonitoredRepo;
  indexingStatus: RepositoryIndexingStatus | undefined;
  onToggle: (repoId: string) => void;
  onRemove: (repoId: string) => void | Promise<void>;
  onStopIndexing: (repoName: string, baseBranch?: string) => void;
  onReindex: (repoName: string, baseBranch?: string) => void;
  onToggleStar: (repoId: string) => void;
  onToggleHidden: (repoId: string) => void;
  onToggleAutoCiFollowup: (repoId: string) => void;
  onUpdateVisualPreview: (repoId: string, settings: RepositoryVisualPreviewSettings) => void;
  isReadOnly: boolean;
}

export const RepositorySettingsBar: React.FC<RepositorySettingsBarProps> = ({
  repo, indexingStatus, onToggle, onRemove, onStopIndexing, onReindex,
  onToggleStar, onToggleHidden, onToggleAutoCiFollowup, onUpdateVisualPreview, isReadOnly,
}) => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const isIndexing = indexingStatus?.indexing_status === 'indexing';

  const handleDeleteConfirm = async () => {
    if (isReadOnly) return;
    setIsDeleting(true);
    try {
      await onRemove(repo.id);
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  return (
    <section
      aria-label={`Settings for ${repo.name}`}
      className="h-full overflow-y-auto scrollbar-stealth p-4 sm:p-6"
    >
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Repository settings</h2>
          <p className="mt-1 break-words text-sm text-slate-500">{repo.name}</p>
        </div>

        <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-800">Repository</h3>
          <label className="flex items-center gap-3 text-sm text-slate-600">
            <input type="checkbox" checked={repo.enabled} onChange={() => onToggle(repo.id)} disabled={isReadOnly} aria-label={`Monitor ${repo.name}`} className="h-4 w-4 accent-teal-600" />
            Monitor repository
          </label>
          <label className="flex items-center gap-3 text-sm text-slate-600">
            <input type="checkbox" checked={repo.starred === true} onChange={() => onToggleStar(repo.id)} disabled={isReadOnly} className="h-4 w-4 accent-teal-600" />
            Star repository
          </label>
          <label className="flex items-center gap-3 text-sm text-slate-600">
            <input type="checkbox" checked={repo.hidden === true} onChange={() => onToggleHidden(repo.id)} disabled={isReadOnly} className="h-4 w-4 accent-teal-600" />
            Hide repository
          </label>
        </div>

        {!isReadOnly && (
          <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-slate-800">Automation</h3>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] items-center gap-x-6 gap-y-4">
              <AutoCiFollowupControl repo={repo} onToggle={onToggleAutoCiFollowup} isReadOnly={isReadOnly} />
              <RepositoryVisualPreviewControl key={repo.id} repo={repo} onUpdate={onUpdateVisualPreview} isReadOnly={isReadOnly} />
            </div>
          </div>
        )}

        <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-800">Indexing</h3>
          <p className="break-words text-xs text-slate-500">Branch: {repo.baseBranch || 'HEAD'}</p>
          <div className="min-w-0 overflow-x-auto">
            {indexingStatus ? <IndexingStatusIndicator status={indexingStatus} /> : <p className="text-xs text-slate-500">Not indexed</p>}
          </div>
          {indexingStatus?.last_indexed_at && (
            <p className="text-xs text-slate-500">Last indexed: {new Date(indexingStatus.last_indexed_at).toLocaleString()}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onReindex(repo.name, repo.baseBranch)}
              disabled={isIndexing || isReadOnly}
              className="inline-flex items-center gap-2 rounded border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isIndexing ? 'animate-spin' : ''}`} />
              Reindex repository
            </button>
            {isIndexing && (
              <button
                type="button"
                onClick={() => onStopIndexing(repo.name, repo.baseBranch)}
                disabled={isReadOnly}
                className="inline-flex items-center gap-2 rounded border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Square className="h-3.5 w-3.5" />
                Stop indexing
              </button>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsDeleteDialogOpen(true)}
          disabled={isReadOnly}
          className="inline-flex items-center gap-2 rounded border border-red-200 bg-white px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove repository
        </button>
      </div>
      <DeleteRepoDialog
        isOpen={isDeleteDialogOpen}
        repoName={repo.name}
        onClose={() => setIsDeleteDialogOpen(false)}
        onConfirm={handleDeleteConfirm}
        isLoading={isDeleting}
      />
    </section>
  );
};
