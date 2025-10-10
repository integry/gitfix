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
    return <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 min-w-[300px] text-gray-400">Loading System Status...</div>;
  }

  if (error) {
    return <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 min-w-[300px] text-red-400">Error: {error}</div>;
  }

  const getStatusColor = (status) => {
    switch (status?.toLowerCase()) {
      case 'running':
      case 'connected':
      case 'authenticated':
      case 'active':
        return '#10b981'; // green-500
      case 'stopped':
      case 'disconnected':
      case 'failed':
      case 'error':
        return '#ef4444'; // red-500
      case 'idle':
        return '#f59e0b'; // amber-500
      default:
        return '#6b7280'; // gray-500
    }
  };

  const getWorkerStatus = () => {
    if (!status?.workers || status.workers.length === 0) return 'No workers';
    const activeCount = status.workers.filter(w => w.status === 'active').length;
    const totalCount = status.workers.length;
    return `${activeCount}/${totalCount} active`;
  };

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 min-w-[300px]">
      <h3 className="text-lg font-semibold text-white mb-6">System Status</h3>
      <div className="flex flex-col gap-3">
        <div className="flex justify-between items-center py-2 border-b border-gray-700">
          <span className="font-medium text-gray-400">Daemon:</span>
          <span className="font-semibold" style={{ color: getStatusColor(status?.daemon) }}>
            {status?.daemon || 'Unknown'}
          </span>
        </div>
        <div className="flex justify-between items-center py-2 border-b border-gray-700">
          <span className="font-medium text-gray-400">Workers:</span>
          <span className="font-semibold text-gray-200">
            {getWorkerStatus()}
          </span>
        </div>
        <div className="flex justify-between items-center py-2 border-b border-gray-700">
          <span className="font-medium text-gray-400">Redis:</span>
          <span className="font-semibold" style={{ color: getStatusColor(status?.redis) }}>
            {status?.redis || 'Unknown'}
          </span>
        </div>
        <div className="flex justify-between items-center py-2 border-b border-gray-700">
          <span className="font-medium text-gray-400">GitHub Auth:</span>
          <span className="font-semibold" style={{ color: getStatusColor(status?.githubAuth) }}>
            {status?.githubAuth || 'Unknown'}
          </span>
        </div>
        <div className="flex justify-between items-center py-2">
          <span className="font-medium text-gray-400">Claude Auth:</span>
          <span className="font-semibold" style={{ color: getStatusColor(status?.claudeAuth) }}>
            {status?.claudeAuth || 'Unknown'}
          </span>
        </div>
      </div>
    </div>
  );
};

export default SystemStatus;