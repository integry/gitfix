// CI retrigger
import React from 'react';
import { BaseBranchSelector } from './BaseBranchSelector';

interface AddRepositoryModalProps {
  isOpen: boolean;
  newRepo: string;
  newAlias: string;
  newBaseBranch: string;
  autoFollowupOnFailedCi: boolean;
  availableRepos: string[];
  onRepoChange: (value: string) => void;
  onAliasChange: (value: string) => void;
  onBaseBranchChange: (value: string) => void;
  onAutoFollowupOnFailedCiChange: (value: boolean) => void;
  onAdd: () => void;
  onClose: () => void;
  isReadOnly?: boolean;
}

export const AddRepositoryModal: React.FC<AddRepositoryModalProps> = ({
  isOpen,
  newRepo,
  newAlias,
  newBaseBranch,
  autoFollowupOnFailedCi,
  availableRepos,
  onRepoChange,
  onAliasChange,
  onBaseBranchChange,
  onAutoFollowupOnFailedCiChange,
  onAdd,
  onClose,
  isReadOnly = false,
}) => {
  const titleId = React.useId();
  const repositoryId = React.useId();
  const aliasId = React.useId();
  const aliasDescriptionId = React.useId();
  const baseBranchId = React.useId();
  const baseBranchLabelId = React.useId();
  const baseBranchDescriptionId = React.useId();

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;
    onAdd();
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4"
      onClick={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-lg max-w-lg w-full max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden border border-gray-300 shadow-lg"
      >
        {/* Modal Header */}
        <div className="flex flex-shrink-0 justify-between items-center px-4 py-3 border-b border-gray-200">
          <h3 id={titleId} className="text-base font-semibold text-gray-900">
            Add Repository
          </h3>
          <button
            type="button"
            aria-label="Close Add Repository"
            className="-mr-1 rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 text-2xl leading-none focus:outline-none focus:ring-2 focus:ring-primary-500"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        {/* Modal Content */}
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div data-testid="add-repository-modal-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">
            <div>
              <label htmlFor={repositoryId} className="block text-sm font-medium text-gray-700 mb-1">Repository *</label>
              <input
                id={repositoryId}
                list={`${repositoryId}-options`}
                value={newRepo}
                onChange={(e) => onRepoChange(e.target.value)}
                placeholder="owner/repo"
                className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md font-mono text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                autoFocus
                disabled={isReadOnly}
              />
              <datalist id={`${repositoryId}-options`}>
                {availableRepos.map(repo => <option key={repo} value={repo} />)}
              </datalist>
            </div>

            <div>
              <label htmlFor={aliasId} className="block text-sm font-medium text-gray-700 mb-1">Alias (optional)</label>
              <input
                id={aliasId}
                value={newAlias}
                onChange={(e) => onAliasChange(e.target.value)}
                placeholder="e.g., Production"
                aria-describedby={aliasDescriptionId}
                className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                disabled={isReadOnly}
              />
              <p id={aliasDescriptionId} className="text-xs text-gray-500 mt-1">
                A friendly name to help identify this repository.
              </p>
            </div>

            <div>
              <label id={baseBranchLabelId} htmlFor={baseBranchId} className="block text-sm font-medium text-gray-700 mb-1">Base Branch (optional)</label>
              <BaseBranchSelector
                repoName={newRepo}
                value={newBaseBranch}
                onChange={onBaseBranchChange}
                placeholder="Select branch..."
                disabled={isReadOnly}
                controlId={baseBranchId}
                labelledBy={baseBranchLabelId}
                describedBy={baseBranchDescriptionId}
                menuPosition="inline"
              />
              <p id={baseBranchDescriptionId} className="text-xs text-gray-500 mt-1">
                You can add the same repository multiple times with different base branches.
              </p>
            </div>

            <label className="flex items-start gap-3 border-t border-gray-200 pt-3">
              <input
                type="checkbox"
                checked={autoFollowupOnFailedCi}
                onChange={(e) => onAutoFollowupOnFailedCiChange(e.target.checked)}
                disabled={isReadOnly}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
              />
              <span>
                <span className="block text-sm font-medium text-gray-700">Automatic CI follow-up</span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  Start an automatic follow-up when this repository's CI fails. Off by default.
                </span>
              </span>
            </label>
          </div>

          {/* Modal Footer */}
          <div data-testid="add-repository-modal-footer" className="flex flex-shrink-0 justify-end gap-2 px-4 py-3 border-t border-gray-200 bg-white">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!newRepo || isReadOnly}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 ${
                !newRepo || isReadOnly
                  ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                  : 'bg-primary-600 text-white hover:bg-primary-700'
              }`}
            >
              Add Repository
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
