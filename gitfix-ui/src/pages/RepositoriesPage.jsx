import React, { useState, useEffect } from 'react';
import { getRepoConfig, updateRepoConfig, getAvailableGithubRepos } from '../api/gitfixApi';

const RepositoriesPage = () => {
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [newRepo, setNewRepo] = useState('');
  const [availableRepos, setAvailableRepos] = useState([]);

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
      setError(err.message || 'Failed to load repositories');
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

  const handleRemoveRepo = (repoNameToRemove) => {
    if (window.confirm(`Are you sure you want to remove the repository "${repoNameToRemove}"?`)) {
      setRepos(repos.filter(repo => repo.name !== repoNameToRemove));
    }
  };

  const handleToggleRepo = (repoNameToToggle) => {
    setRepos(
      repos.map(repo =>
        repo.name === repoNameToToggle ? { ...repo, enabled: !repo.enabled } : repo
      )
    );
  };

  const handleSave = async () => {
    setError(null);
    setSuccess(null);
    setSaving(true);
    
    try {
      for (const repo of repos) {
        if (!/^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_]+$/.test(repo.name)) {
          throw new Error(`Invalid repository format: "${repo.name}"`);
        }
      }
      await updateRepoConfig(repos);
      setSuccess('Repository list updated successfully! The daemon will pick up changes within 5 minutes.');
    } catch (err) {
      setError(err.message || 'Failed to update repository list');
    } finally {
      setSaving(false);
    }
  };

  if (loading && repos.length === 0) {
    return (
      <div>
        <h2 style={{ color: '#fff', fontSize: '1.5rem', marginBottom: '1rem' }}>Repositories</h2>
        <p style={{ color: '#9ca3af' }}>Loading repositories...</p>
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ color: '#fff', fontSize: '1.5rem', marginBottom: '1rem' }}>Manage Monitored Repositories</h2>
      <p style={{ color: '#9ca3af', marginBottom: '1rem' }}>
        Add repositories to monitor, enable/disable them, or remove them from the list. Changes will be automatically picked up by the daemon within 5 minutes.
      </p>
      
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
        <input
          list="available-repos"
          value={newRepo}
          onChange={(e) => setNewRepo(e.target.value)}
          placeholder="owner/repo or select from list"
          style={{
            flex: 1,
            padding: '0.5rem',
            backgroundColor: '#1f2937',
            color: '#fff',
            border: '1px solid #374151',
            borderRadius: '0.375rem',
            fontFamily: 'monospace'
          }}
        />
        <datalist id="available-repos">
          {availableRepos
            .filter(repo => !repos.some(r => r.name === repo))
            .map(repo => <option key={repo} value={repo} />)}
        </datalist>
        <button
          onClick={handleAddRepo}
          disabled={!newRepo || repos.some(r => r.name === newRepo)}
          style={{
            padding: '0.5rem 1rem',
            backgroundColor: !newRepo || repos.some(r => r.name === newRepo) ? '#6b7280' : '#10B981',
            color: '#fff',
            border: 'none',
            borderRadius: '0.375rem',
            cursor: !newRepo || repos.some(r => r.name === newRepo) ? 'not-allowed' : 'pointer',
            fontSize: '0.9rem',
            fontWeight: '500'
          }}
        >
          Add Repository
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem' }}>
        {repos.map(repo => (
          <div
            key={repo.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.75rem 1rem',
              backgroundColor: '#374151',
              borderRadius: '0.375rem',
            }}
          >
            <span style={{ fontFamily: 'monospace', color: '#fff', opacity: repo.enabled ? 1 : 0.5 }}>
              {repo.name}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', color: '#9ca3af' }}>
                <input
                  type="checkbox"
                  checked={repo.enabled}
                  onChange={() => handleToggleRepo(repo.name)}
                  style={{ marginRight: '0.5rem', height: '1rem', width: '1rem', cursor: 'pointer' }}
                />
                Enabled
              </label>
              <button
                onClick={() => handleRemoveRepo(repo.name)}
                style={{
                  backgroundColor: '#EF4444',
                  fontSize: '0.75rem',
                  padding: '0.25rem 0.75rem',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '0.375rem',
                  cursor: 'pointer',
                  fontWeight: '500'
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {repos.length === 0 && (
          <p style={{ color: '#9ca3af', textAlign: 'center', padding: '2rem' }}>
            No repositories configured. Add a repository to get started.
          </p>
        )}
      </div>
      
      <button
        onClick={handleSave}
        disabled={saving || repos.length === 0}
        style={{
          padding: '0.75rem 1.5rem',
          backgroundColor: saving || repos.length === 0 ? '#6b7280' : '#3b82f6',
          color: '#fff',
          border: 'none',
          borderRadius: '0.375rem',
          cursor: saving || repos.length === 0 ? 'not-allowed' : 'pointer',
          fontSize: '1rem',
          fontWeight: 'bold'
        }}
      >
        {saving ? 'Saving...' : 'Save All Changes'}
      </button>
      
      {error && (
        <div style={{
          color: '#ef4444',
          marginTop: '1rem',
          padding: '0.75rem',
          backgroundColor: '#7f1d1d',
          borderRadius: '0.375rem',
          border: '1px solid #991b1b'
        }}>
          {error}
        </div>
      )}
      
      {success && (
        <div style={{
          color: '#10b981',
          marginTop: '1rem',
          padding: '0.75rem',
          backgroundColor: '#064e3b',
          borderRadius: '0.375rem',
          border: '1px solid #065f46'
        }}>
          {success}
        </div>
      )}
    </div>
  );
};

export default RepositoriesPage;
