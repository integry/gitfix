import React, { useState, useEffect } from 'react';
import { getRepoConfig, updateRepoConfig, getAvailableGithubRepos } from '../api/gitfixApi';

interface Repo {
  name: string;
  enabled: boolean;
}

const RepositoriesPage: React.FC = () => {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [newRepo, setNewRepo] = useState<string>('');
  const [availableRepos, setAvailableRepos] = useState<string[]>([]);

  useEffect(() => {
    loadRepos();
    loadAvailableRepos();
  }, []);

  const loadRepos = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getRepoConfig();
      setRepos(data.repos_to_monitor || []);
    } catch (err) {
      setError((err as Error).message || 'Failed to load repositories');
    } finally {
      setLoading(false);
    }
  };

  const loadAvailableRepos = async () => {
    try {
      const data = await getAvailableGithubRepos();
      setAvailableRepos(data.repos || []);
    } catch (err) {
      console.error('Failed to load available GitHub repos:', err);
    }
  };

  const handleAddRepo = () => {
    if (!newRepo) return;

    if (repos.some(r => r.name === newRepo)) {
      alert(`Repository "${newRepo}" has already been added to the list.`);
      return;
    }

    setRepos([...repos, { name: newRepo, enabled: true }]);
    setNewRepo('');
  };

  const handleRemoveRepo = (repoName: string) => {
    setRepos(repos.filter(r => r.name !== repoName));
  };

  const handleToggleRepo = (repoName: string) => {
    setRepos(repos.map(repo => 
      repo.name === repoName 
        ? { ...repo, enabled: !repo.enabled }
        : repo
    ));
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);
      
      // Validate that at least one repository is enabled
      const enabledRepos = repos.filter(r => r.enabled);
      if (enabledRepos.length === 0 && repos.length > 0) {
        if (!window.confirm('No repositories are enabled. This will effectively disable GitFix monitoring. Continue?')) {
          return;
        }
      }
      await updateRepoConfig(repos);
      setSuccess('Repository list updated successfully! The daemon will pick up changes within 5 minutes.');
    } catch (err) {
      setError((err as Error).message || 'Failed to update repository list');
    } finally {
      setSaving(false);
    }
  };

  if (loading && repos.length === 0) {
    return (
      <div>
        <h2 className="text-brand-text-light text-2xl font-semibold mb-4">Repositories</h2>
        <p className="text-brand-text-dim">Loading repositories...</p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-brand-text-light text-2xl font-semibold mb-4">Manage Monitored Repositories</h2>
      <p className="text-brand-text-dim mb-4">
        Add repositories to monitor, enable/disable them, or remove them from the list. Changes will be automatically picked up by the daemon within 5 minutes.
      </p>
      
      <div className="flex gap-4 mb-6">
        <input
          list="available-repos"
          value={newRepo}
          onChange={(e) => setNewRepo(e.target.value)}
          placeholder="owner/repo or select from list"
          className="flex-1 px-3 py-2 bg-brand-component text-brand-text-light border border-brand-border rounded-md font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        <datalist id="available-repos">
          {availableRepos
            .filter(repo => !repos.some(r => r.name === repo))
            .map(repo => <option key={repo} value={repo} />)}
        </datalist>
        <button
          onClick={handleAddRepo}
          disabled={!newRepo || repos.some(r => r.name === newRepo)}
          className={`px-4 py-2 text-brand-text-light font-medium rounded-md transition-colors ${
            !newRepo || repos.some(r => r.name === newRepo)
              ? 'bg-gray-600 cursor-not-allowed'
              : 'bg-green-600 hover:bg-green-700 cursor-pointer'
          }`}
        >
          Add Repository
        </button>
      </div>

      <div className="flex flex-col gap-2 mb-6">
        {repos.map(repo => (
          <div
            key={repo.name}
            className="flex items-center justify-between px-4 py-3 bg-brand-border rounded-md"
          >
            <span className={`font-mono text-brand-text-light ${repo.enabled ? 'opacity-100' : 'opacity-50'}`}>
              {repo.name}
            </span>
            <div className="flex items-center gap-4">
              <label className="flex items-center cursor-pointer text-brand-text-dim">
                <input
                  type="checkbox"
                  checked={repo.enabled}
                  onChange={() => handleToggleRepo(repo.name)}
                  className="mr-2 h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                Enabled
              </label>
              <button
                onClick={() => handleRemoveRepo(repo.name)}
                className="bg-red-600 hover:bg-red-700 text-xs px-3 py-1 text-brand-text-light rounded-md font-medium transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {repos.length === 0 && (
          <p className="text-brand-text-dim text-center py-8">
            No repositories configured. Add a repository to get started.
          </p>
        )}
      </div>
      
      <button
        onClick={handleSave}
        disabled={saving || repos.length === 0}
        className={`px-6 py-3 text-brand-text-light font-medium rounded-md transition-colors ${
          saving || repos.length === 0
            ? 'bg-gray-600 cursor-not-allowed'
            : 'bg-brand-accent hover:bg-brand-accent-hover cursor-pointer'
        }`}
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
      
      {error && (
        <div className="mt-4 p-4 bg-red-900/20 border border-red-700 rounded-md text-brand-red">
          {error}
        </div>
      )}
      
      {success && (
        <div className="mt-4 p-4 bg-green-900/20 border border-green-700 rounded-md text-brand-green">
          {success}
        </div>
      )}
    </div>
  );
};

export default RepositoriesPage;