import React, { useState, useEffect } from 'react';
import { getQueueStats } from '../api/gitfixApi';

const TaskQueueStats = () => {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        const data = await getQueueStats();
        setStats(data);
        setError(null);
      } catch (err) {
        setError('Failed to fetch queue stats');
        console.error('Error fetching queue stats:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading && !stats) {
    return <div className="stats-container">Loading Queue Stats...</div>;
  }

  if (error) {
    return <div className="stats-container error">Error: {error}</div>;
  }

  const getStatColor = (type, value) => {
    if (type === 'failed' && value > 0) return '#f87171';
    if (type === 'active' && value > 0) return '#4ade80';
    if (type === 'waiting' && value > 10) return '#fbbf24';
    return '#6b7280';
  };

  return (
    <div className="stats-container" style={{
      border: '1px solid #e5e7eb',
      borderRadius: '8px',
      padding: '1.5rem',
      backgroundColor: '#ffffff',
      minWidth: '300px'
    }}>
      <h3>Task Queue</h3>
      <div className="stats-grid" style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '1rem'
      }}>
        <div className="stat-item">
          <div className="stat-label">Active</div>
          <div className="stat-value" style={{ 
            fontSize: '2rem', 
            fontWeight: 'bold',
            color: getStatColor('active', stats?.active)
          }}>
            {stats?.active || 0}
          </div>
        </div>
        <div className="stat-item">
          <div className="stat-label">Waiting</div>
          <div className="stat-value" style={{ 
            fontSize: '2rem', 
            fontWeight: 'bold',
            color: getStatColor('waiting', stats?.waiting)
          }}>
            {stats?.waiting || 0}
          </div>
        </div>
        <div className="stat-item">
          <div className="stat-label">Completed (24h)</div>
          <div className="stat-value" style={{ 
            fontSize: '2rem', 
            fontWeight: 'bold',
            color: getStatColor('completed', stats?.completed)
          }}>
            {stats?.completed || 0}
          </div>
        </div>
        <div className="stat-item">
          <div className="stat-label">Failed</div>
          <div className="stat-value" style={{ 
            fontSize: '2rem', 
            fontWeight: 'bold',
            color: getStatColor('failed', stats?.failed)
          }}>
            {stats?.failed || 0}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaskQueueStats;