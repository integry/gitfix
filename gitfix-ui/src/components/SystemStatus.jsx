import React, { useState, useEffect } from 'react';
import { getSystemStatus } from '../api/gitfixApi';

const SystemStatus = () => {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        setLoading(true);
        const data = await getSystemStatus();
        setStatus(data);
        setError(null);
      } catch (err) {
        setError('Failed to fetch system status');
        console.error('Error fetching system status:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading && !status) {
    return <div className="status-container">Loading System Status...</div>;
  }

  if (error) {
    return <div className="status-container error">Error: {error}</div>;
  }

  const getStatusColor = (status) => {
    switch (status?.toLowerCase()) {
      case 'running':
      case 'connected':
      case 'authenticated':
      case 'active':
        return '#4ade80';
      case 'stopped':
      case 'disconnected':
      case 'failed':
      case 'error':
        return '#f87171';
      case 'idle':
        return '#fbbf24';
      default:
        return '#9ca3af';
    }
  };

  const getWorkerStatus = () => {
    if (!status?.workers || status.workers.length === 0) return 'No workers';
    const activeCount = status.workers.filter(w => w.status === 'active').length;
    const totalCount = status.workers.length;
    return `${activeCount}/${totalCount} active`;
  };

  return (
    <div className="status-container" style={{
      border: '1px solid #e5e7eb',
      borderRadius: '8px',
      padding: '1.5rem',
      backgroundColor: '#ffffff',
      minWidth: '300px'
    }}>
      <h3>System Status</h3>
      <div className="status-list">
        <div className="status-item">
          <span className="status-label">Daemon:</span>
          <span className="status-value" style={{ color: getStatusColor(status?.daemon) }}>
            {status?.daemon || 'Unknown'}
          </span>
        </div>
        <div className="status-item">
          <span className="status-label">Workers:</span>
          <span className="status-value">
            {getWorkerStatus()}
          </span>
        </div>
        <div className="status-item">
          <span className="status-label">Redis:</span>
          <span className="status-value" style={{ color: getStatusColor(status?.redis) }}>
            {status?.redis || 'Unknown'}
          </span>
        </div>
        <div className="status-item">
          <span className="status-label">GitHub Auth:</span>
          <span className="status-value" style={{ color: getStatusColor(status?.githubAuth) }}>
            {status?.githubAuth || 'Unknown'}
          </span>
        </div>
        <div className="status-item">
          <span className="status-label">Claude Auth:</span>
          <span className="status-value" style={{ color: getStatusColor(status?.claudeAuth) }}>
            {status?.claudeAuth || 'Unknown'}
          </span>
        </div>
      </div>
    </div>
  );
};

export default SystemStatus;