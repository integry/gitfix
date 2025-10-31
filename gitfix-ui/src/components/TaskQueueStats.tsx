import React, { useState, useEffect } from 'react';
import { getQueueStats } from '../api/gitfixApi';

interface QueueStats {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
}

const TaskQueueStats: React.FC = () => {
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

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
    return <div className="bg-brand-component border border-brand-border rounded-lg p-6 min-w-[300px] text-brand-text-dim">Loading Queue Stats...</div>;
  }

  if (error) {
    return <div className="bg-brand-component border border-brand-border rounded-lg p-6 min-w-[300px] text-brand-red">Error: {error}</div>;
  }

  const getStatColor = (type: string, value: number): string => {
    if (type === 'failed' && value > 0) return '#EF4444';
    if (type === 'active' && value > 0) return '#10B981';
    if (type === 'waiting' && value > 10) return '#F59E0B';
    if (type === 'completed') return '#3B82F6';
    return '#94A3B8';
  };

  return (
    <div className="bg-brand-component border border-brand-border rounded-lg p-6 min-w-[300px]">
      <h3 className="text-lg font-semibold text-brand-text-light mb-6">Task Queue</h3>
      <div className="grid grid-cols-2 gap-4">
        <div className="stat-item bg-brand-border/30 rounded-lg p-4 text-center">
          <div className="text-sm text-brand-text-dim mb-1">Active</div>
          <div className="text-3xl font-bold" style={{ color: getStatColor('active', stats?.active) }}>
            {stats?.active || 0}
          </div>
        </div>
        <div className="stat-item bg-brand-border/30 rounded-lg p-4 text-center">
          <div className="text-sm text-brand-text-dim mb-1">Waiting</div>
          <div className="text-3xl font-bold" style={{ color: getStatColor('waiting', stats?.waiting) }}>
            {stats?.waiting || 0}
          </div>
        </div>
        <div className="stat-item bg-brand-border/30 rounded-lg p-4 text-center">
          <div className="text-sm text-brand-text-dim mb-1">Completed (24h)</div>
          <div className="text-3xl font-bold" style={{ color: getStatColor('completed', stats?.completed) }}>
            {stats?.completed || 0}
          </div>
        </div>
        <div className="stat-item bg-brand-border/30 rounded-lg p-4 text-center">
          <div className="text-sm text-brand-text-dim mb-1">Failed</div>
          <div className="text-3xl font-bold" style={{ color: getStatColor('failed', stats?.failed) }}>
            {stats?.failed || 0}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaskQueueStats;