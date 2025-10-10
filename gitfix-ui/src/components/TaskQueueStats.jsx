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
    return <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 min-w-[300px] text-gray-400">Loading Queue Stats...</div>;
  }

  if (error) {
    return <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 min-w-[300px] text-red-400">Error: {error}</div>;
  }

  const getStatColor = (type, value) => {
    if (type === 'failed' && value > 0) return '#ef4444';
    if (type === 'active' && value > 0) return '#10b981';
    if (type === 'waiting' && value > 10) return '#f59e0b';
    if (type === 'completed') return '#3b82f6';
    return '#6b7280';
  };

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 min-w-[300px]">
      <h3 className="text-lg font-semibold text-white mb-6">Task Queue</h3>
      <div className="grid grid-cols-2 gap-4">
        <div className="stat-item bg-gray-700/50 rounded-lg p-4 text-center">
          <div className="text-sm text-gray-400 mb-1">Active</div>
          <div className="text-3xl font-bold" style={{ color: getStatColor('active', stats?.active) }}>
            {stats?.active || 0}
          </div>
        </div>
        <div className="stat-item bg-gray-700/50 rounded-lg p-4 text-center">
          <div className="text-sm text-gray-400 mb-1">Waiting</div>
          <div className="text-3xl font-bold" style={{ color: getStatColor('waiting', stats?.waiting) }}>
            {stats?.waiting || 0}
          </div>
        </div>
        <div className="stat-item bg-gray-700/50 rounded-lg p-4 text-center">
          <div className="text-sm text-gray-400 mb-1">Completed (24h)</div>
          <div className="text-3xl font-bold" style={{ color: getStatColor('completed', stats?.completed) }}>
            {stats?.completed || 0}
          </div>
        </div>
        <div className="stat-item bg-gray-700/50 rounded-lg p-4 text-center">
          <div className="text-sm text-gray-400 mb-1">Failed</div>
          <div className="text-3xl font-bold" style={{ color: getStatColor('failed', stats?.failed) }}>
            {stats?.failed || 0}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaskQueueStats;