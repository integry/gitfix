import React, { useState, useEffect } from 'react';
import { getSettings, updateSettings, getFollowupKeywords, updateFollowupKeywords } from '../api/gitfixApi';

const SettingsPage = () => {
  const [settings, setSettings] = useState({
    worker_concurrency: '',
    github_user_whitelist: ''
  });
  const [keywords, setKeywords] = useState([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [keywordsLoading, setKeywordsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [keywordsSaving, setKeywordsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [keywordsError, setKeywordsError] = useState(null);
  const [keywordsSuccess, setKeywordsSuccess] = useState(null);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await getSettings();
        setSettings({
          worker_concurrency: data.worker_concurrency || '',
          github_user_whitelist: (data.github_user_whitelist || []).join(', ')
        });
      } catch (err) {
        setError(err.message || 'Failed to load settings');
      } finally {
        setLoading(false);
      }
    };
    loadSettings();
  }, []);

  useEffect(() => {
    const loadKeywords = async () => {
      try {
        setKeywordsLoading(true);
        setKeywordsError(null);
        const data = await getFollowupKeywords();
        setKeywords(data.followup_keywords || []);
      } catch (err) {
        setKeywordsError(err.message || 'Failed to load keywords');
      } finally {
        setKeywordsLoading(false);
      }
    };
    loadKeywords();
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setSettings(prev => ({ ...prev, [name]: value }));
  };

  const handleSave = async () => {
    setError(null);
    setSuccess(null);
    setSaving(true);

    try {
      const payload = {
        worker_concurrency: parseInt(settings.worker_concurrency, 10) || 0,
        github_user_whitelist: settings.github_user_whitelist.split(',').map(s => s.trim()).filter(Boolean)
      };
      await updateSettings(payload);
      setSuccess('Settings updated successfully! Changes will be effective on next service restart/reload.');
    } catch (err) {
      setError(err.message || 'Failed to update settings');
    } finally {
      setSaving(false);
    }
  };

  const handleAddKeyword = () => {
    if (newKeyword && !keywords.includes(newKeyword)) {
      setKeywords([...keywords, newKeyword]);
      setNewKeyword('');
    }
  };

  const handleRemoveKeyword = (keywordToRemove) => {
    setKeywords(keywords.filter(k => k !== keywordToRemove));
  };

  const handleSaveKeywords = async () => {
    setKeywordsError(null);
    setKeywordsSuccess(null);
    setKeywordsSaving(true);
    try {
      await updateFollowupKeywords(keywords);
      setKeywordsSuccess('Keywords updated successfully!');
    } catch (err) {
      setKeywordsError(err.message || 'Failed to update keywords');
    } finally {
      setKeywordsSaving(false);
    }
  };

  if (loading) {
    return <div>Loading settings...</div>;
  }

  return (
    <div>
      <h2 style={{ color: '#fff', fontSize: '1.5rem', marginBottom: '1rem' }}>GitFix Settings</h2>
      <p style={{ color: '#9ca3af', marginBottom: '2rem' }}>
        Configure system-wide settings. These settings from the config repository will override any values set in the '.env' file.
      </p>

      <div style={{ marginBottom: '3rem' }}>
        <h3 style={{ color: '#fff', fontSize: '1.25rem', marginBottom: '1rem' }}>PR Follow-up Trigger Keywords</h3>
        <div style={{ backgroundColor: '#374151', padding: '1.5rem', borderRadius: '0.5rem' }}>
          <p style={{ color: '#9ca3af', marginBottom: '1rem' }}>
            Manage keywords that trigger AI follow-ups on pull request comments. If no keywords are specified, any comment from a whitelisted user will trigger a follow-up.
          </p>

          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
            <input
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleAddKeyword()}
              placeholder="Enter new keyword (e.g., !gitfix)"
              style={{
                flex: 1,
                padding: '0.5rem',
                backgroundColor: '#1f2937',
                color: '#fff',
                border: '1px solid #4b5563',
                borderRadius: '0.375rem',
              }}
            />
            <button 
              onClick={handleAddKeyword} 
              style={{ 
                backgroundColor: '#10B981', 
                color: '#fff', 
                border: 'none', 
                padding: '0.5rem 1rem', 
                borderRadius: '0.375rem', 
                cursor: 'pointer',
                fontWeight: 'bold'
              }}
            >
              Add
            </button>
          </div>

          {keywordsLoading ? <p style={{ color: '#9ca3af' }}>Loading keywords...</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem' }}>
              {keywords.map((keyword, index) => (
                <div key={index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#4b5563', padding: '0.5rem 1rem', borderRadius: '0.375rem' }}>
                  <span style={{ color: '#fff' }}>{keyword}</span>
                  <button 
                    onClick={() => handleRemoveKeyword(keyword)} 
                    style={{ 
                      backgroundColor: '#EF4444', 
                      color: '#fff', 
                      border: 'none', 
                      padding: '0.25rem 0.75rem', 
                      borderRadius: '0.375rem', 
                      cursor: 'pointer',
                      fontSize: '0.875rem'
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              {keywords.length === 0 && <p style={{ color: '#9ca3af', textAlign: 'center' }}>No keywords configured. All whitelisted user comments will trigger follow-ups.</p>}
            </div>
          )}

          <button 
            onClick={handleSaveKeywords} 
            disabled={keywordsSaving} 
            style={{ 
              backgroundColor: keywordsSaving ? '#6b7280' : '#3b82f6', 
              color: '#fff', 
              width: '100%', 
              border: 'none', 
              padding: '0.75rem', 
              borderRadius: '0.375rem', 
              cursor: keywordsSaving ? 'not-allowed' : 'pointer',
              fontSize: '1rem',
              fontWeight: 'bold'
            }}
          >
            {keywordsSaving ? 'Saving...' : 'Save Keywords'}
          </button>

          {keywordsError && <p style={{ color: '#ef4444', marginTop: '1rem' }}>Error: {keywordsError}</p>}
          {keywordsSuccess && <p style={{ color: '#10b981', marginTop: '1rem' }}>{keywordsSuccess}</p>}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '600px' }}>
        <div>
          <label htmlFor='worker_concurrency' style={{ display: 'block', color: '#d1d5db', marginBottom: '0.5rem' }}>
            Worker Concurrency
          </label>
          <input
            type='number'
            id='worker_concurrency'
            name='worker_concurrency'
            value={settings.worker_concurrency}
            onChange={handleChange}
            placeholder='e.g., 5'
            style={{ width: '100%', padding: '0.5rem', backgroundColor: '#1f2937', color: '#fff', border: '1px solid #374151', borderRadius: '0.375rem' }}
          />
          <p style={{ fontSize: '0.875rem', color: '#9ca3af', marginTop: '0.5rem' }}>
            Number of jobs a worker can process concurrently.
          </p>
        </div>

        <div>
          <label htmlFor='github_user_whitelist' style={{ display: 'block', color: '#d1d5db', marginBottom: '0.5rem' }}>
            GitHub User Whitelist
          </label>
          <textarea
            id='github_user_whitelist'
            name='github_user_whitelist'
            value={settings.github_user_whitelist}
            onChange={handleChange}
            placeholder='e.g., user1,user2,user3'
            rows='3'
            style={{ width: '100%', padding: '0.5rem', backgroundColor: '#1f2937', color: '#fff', border: '1px solid #374151', borderRadius: '0.375rem', fontFamily: 'monospace' }}
          />
          <p style={{ fontSize: '0.875rem', color: '#9ca3af', marginTop: '0.5rem' }}>
            Comma-separated list of GitHub usernames allowed to trigger actions via PR comments.
          </p>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '0.75rem 1.5rem',
            backgroundColor: saving ? '#6b7280' : '#3b82f6',
            color: '#fff',
            border: 'none',
            borderRadius: '0.375rem',
            cursor: saving ? 'not-allowed' : 'pointer',
            fontSize: '1rem',
            fontWeight: 'bold',
            alignSelf: 'flex-start'
          }}
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      {error && (
        <div style={{ color: '#ef4444', marginTop: '1rem', padding: '0.75rem', backgroundColor: '#7f1d1d', borderRadius: '0.375rem', border: '1px solid #991b1b' }}>
          {error}
        </div>
      )}
      
      {success && (
        <div style={{ color: '#10b981', marginTop: '1rem', padding: '0.75rem', backgroundColor: '#064e3b', borderRadius: '0.375rem', border: '1px solid #065f46' }}>
          {success}
        </div>
      )}
    </div>
  );
};

export default SettingsPage;
