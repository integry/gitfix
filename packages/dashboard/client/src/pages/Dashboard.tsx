import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import { SystemStatusPanel } from '../components/SystemStatusPanel';
import { QueueStatsPanel } from '../components/QueueStatsPanel';
import { ActivityFeed } from '../components/ActivityFeed';
import { MetricsPanel } from '../components/MetricsPanel';
import { LLMMetricsPanel } from '../components/LLMMetricsPanel';

const Dashboard: React.FC = () => {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Header */}
      <header className="bg-gray-800 shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div>
              <h1 className="text-2xl font-bold text-white">GitFix Dashboard</h1>
              <p className="text-gray-400 text-sm">
                Welcome, {user?.displayName || user?.username}!
              </p>
            </div>
            <button
              onClick={logout}
              className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg transition-colors"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* System Status Panel */}
          <div className="lg:col-span-1">
            <SystemStatusPanel />
          </div>

          {/* Queue Statistics Panel */}
          <div className="lg:col-span-1">
            <QueueStatsPanel />
          </div>

          {/* Metrics Panel */}
          <div className="lg:col-span-2">
            <MetricsPanel />
          </div>

          {/* LLM Metrics Panel */}
          <div className="lg:col-span-2">
            <LLMMetricsPanel />
          </div>

          {/* Activity Feed */}
          <div className="lg:col-span-2">
            <ActivityFeed />
          </div>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;