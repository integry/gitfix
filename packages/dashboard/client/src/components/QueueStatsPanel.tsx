import React from 'react';
import { Link } from 'react-router-dom';
import { useApiData } from '../hooks/useApiData';

interface QueueStats {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  activeJobs?: Array<{
    id: string;
    name: string;
    data?: Record<string, unknown>;
    progress?: number;
  }>;
}

interface StatCardProps {
  label: string;
  value: number;
  colorClass: string;
}

const StatCard: React.FC<StatCardProps> = ({ label, value, colorClass }) => {
  return (
    <div className="bg-gray-700 rounded p-3">
      <div className="text-sm text-gray-400">{label}</div>
      <div className={`text-2xl font-bold ${colorClass}`}>{value}</div>
    </div>
  );
};

export const QueueStatsPanel: React.FC = () => {
  const { data: stats, error, loading } = useApiData<QueueStats>('/api/queue/stats');

  if (loading && !stats) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-4">
        <h2 className="text-lg font-bold mb-4 text-white">Queue Statistics</h2>
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-4">
        <h2 className="text-lg font-bold mb-4 text-white">Queue Statistics</h2>
        <div className="text-red-500">Failed to load queue statistics.</div>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg shadow-md p-4">
      <h2 className="text-lg font-bold mb-4 text-white">Queue Statistics</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <StatCard label="Active" value={stats?.active || 0} colorClass="text-blue-400" />
        <StatCard label="Waiting" value={stats?.waiting || 0} colorClass="text-yellow-400" />
        <StatCard label="Completed" value={stats?.completed || 0} colorClass="text-green-400" />
        <StatCard label="Failed" value={stats?.failed || 0} colorClass="text-red-400" />
        <StatCard label="Delayed" value={stats?.delayed || 0} colorClass="text-orange-400" />
        <StatCard label="Paused" value={stats?.paused || 0} colorClass="text-gray-400" />
      </div>
      
      {stats?.activeJobs && stats.activeJobs.length > 0 && (
        <div className="mt-4 border-t border-gray-700 pt-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Active Jobs</h3>
          <div className="space-y-2">
            {stats.activeJobs.slice(0, 5).map((job) => (
              <Link
                key={job.id}
                to={`/tasks/${job.id}`}
                className="block bg-gray-700 rounded p-2 hover:bg-gray-600 transition-colors"
              >
                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-200">{job.name}</span>
                  <span className="text-xs text-gray-400">#{job.id}</span>
                </div>
                {job.progress !== undefined && (
                  <div className="mt-1">
                    <div className="h-2 bg-gray-600 rounded">
                      <div
                        className="h-2 bg-blue-500 rounded"
                        style={{ width: `${job.progress}%` }}
                      />
                    </div>
                  </div>
                )}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};