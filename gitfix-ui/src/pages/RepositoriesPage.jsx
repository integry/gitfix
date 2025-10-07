import React, { useState, useEffect } from 'react';
import { getRepoConfig, updateRepoConfig } from '../api/gitfixApi';

const RepositoriesPage = () => {
  const [repos, setRepos] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    loadRepos();
  }, []);

  const loadRepos = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getRepoConfig();
      setRepos(data.repos_to_monitor.join('\n'));
    } catch (err) {
      setError(err.message || 'Failed to load repositories');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setError(null);
    setSuccess(null);
    setSaving(true);
    
    const repoList = repos.split('\n').map(r => r.trim()).filter(Boolean);
    
    try {
      await updateRepoConfig(repoList);
      setSuccess('Repository list updated successfully! Changes will be picked up within 5 minutes.');
    } catch (err) {
      setError(err.message || 'Failed to update repository list');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !repos) {
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
        Enter one repository per line (e.g., 'owner/repo'). Changes will be automatically picked up by the daemon within 5 minutes.
      </p>
      
      <textarea
        value={repos}
        onChange={(e) => setRepos(e.target.value)}
        rows={15}
        style={{
          width: '100%',
          fontFamily: 'monospace',
          fontSize: '0.9rem',
          padding: '0.75rem',
          backgroundColor: '#1f2937',
          color: '#fff',
          border: '1px solid #374151',
          borderRadius: '0.375rem',
          marginBottom: '1rem',
          resize: 'vertical'
        }}
        disabled={saving}
        placeholder="owner/repo1&#10;owner/repo2&#10;owner/repo3"
      />
      
      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          padding: '0.5rem 1rem',
          backgroundColor: saving ? '#6b7280' : '#3b82f6',
          color: '#fff',
          border: 'none',
          borderRadius: '0.375rem',
          cursor: saving ? 'not-allowed' : 'pointer',
          fontSize: '0.9rem',
          fontWeight: '500'
        }}
      >
        {saving ? 'Saving...' : 'Save Changes'}
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
