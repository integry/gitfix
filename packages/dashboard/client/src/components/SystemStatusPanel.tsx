import React from 'react';
import { useApiData } from '../hooks/useApiData';

interface SystemStatus {
  daemon: string;
  redis: string;
  githubAuth: string;
  claudeAuth?: string;
}

interface StatusIndicatorProps {
  status: string | undefined;
  text: string;
}

const StatusIndicator: React.FC<StatusIndicatorProps> = ({ status, text }) => {
  const isOk = status && (status === 'ok' || status === 'running' || status === 'connected');
  const bgColor = isOk ? 'bg-green-500' : 'bg-red-500';

  return (
    <div className="flex items-center justify-between p-2">
      <span className="text-gray-300">{text}</span>
      <div className="flex items-center">
        <span className={`w-3 h-3 rounded-full ${bgColor} mr-2`}></span>
        <span className="capitalize text-gray-200">{status || 'loading...'}</span>
      </div>
    </div>
  );
};

export const SystemStatusPanel: React.FC = () => {
  const { data: status, error, loading } = useApiData<SystemStatus>('/api/status');

  if (loading && !status) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-4">
        <h2 className="text-lg font-bold mb-2 text-white">System Status</h2>
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-4">
        <h2 className="text-lg font-bold mb-2 text-white">System Status</h2>
        <div className="text-red-500">Failed to load system status.</div>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg shadow-md p-4">
      <h2 className="text-lg font-bold mb-2 text-white">System Status</h2>
      <div className="divide-y divide-gray-700">
        <StatusIndicator status={status?.daemon} text="Daemon" />
        <StatusIndicator status={status?.redis} text="Redis Connection" />
        <StatusIndicator status={status?.githubAuth} text="GitHub App Auth" />
        {status?.claudeAuth !== undefined && (
          <StatusIndicator status={status.claudeAuth} text="Claude Auth" />
        )}
      </div>
    </div>
  );
};