import React from 'react';
import type { MonitoredRepo } from '../api/proprApi';
import { RepositoryVisualPreviewControl, type RepositoryVisualPreviewSettings } from './RepositoryVisualPreviewControl';

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
  onToggleAutoCiFollowup: (repoId: string) => void;
  onUpdateVisualPreview: (repoId: string, settings: RepositoryVisualPreviewSettings) => void;
  isReadOnly: boolean;
}

export const RepositorySettingsBar: React.FC<RepositorySettingsBarProps> = ({
  repo, onToggleAutoCiFollowup, onUpdateVisualPreview, isReadOnly,
}) => {
  if (isReadOnly) return null;

  return (
    <section
      aria-label={`Settings for ${repo.name}`}
      className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] items-center gap-x-6 gap-y-3 shrink-0 max-h-[45%] overflow-y-auto bg-slate-50 border-b border-slate-200 p-3"
    >
      <AutoCiFollowupControl repo={repo} onToggle={onToggleAutoCiFollowup} isReadOnly={isReadOnly} />
      <RepositoryVisualPreviewControl key={repo.id} repo={repo} onUpdate={onUpdateVisualPreview} isReadOnly={isReadOnly} />
    </section>
  );
};
