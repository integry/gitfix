import React from 'react';
import { useApiData } from '../hooks/useApiData';

interface Metrics {
  totalIssuesProcessed: number;
  successRate: number;
  averageProcessingTime: number;
  activeRepositories: number;
  dailyStats?: {
    date: string;
    processed: number;
    successful: number;
    failed: number;
  }[];
}

interface MetricCardProps {
  label: string;
  value: string | number;
  unit?: string;
  trend?: 'up' | 'down' | 'stable';
  trendValue?: string;
}

const MetricCard: React.FC<MetricCardProps> = ({ label, value, unit, trend, trendValue }) => {
  const getTrendIcon = () => {
    switch (trend) {
      case 'up':
        return '↑';
      case 'down':
        return '↓';
      default:
        return '→';
    }
  };

  const getTrendColor = () => {
    switch (trend) {
      case 'up':
        return 'text-green-400';
      case 'down':
        return 'text-red-400';
      default:
        return 'text-gray-400';
    }
  };

  return (
    <div className="bg-gray-700 rounded-lg p-4">
      <div className="text-sm text-gray-400 mb-2">{label}</div>
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline">
          <span className="text-2xl font-bold text-white">{value}</span>
          {unit && <span className="text-sm text-gray-400 ml-1">{unit}</span>}
        </div>
        {trend && trendValue && (
          <div className={`flex items-center text-xs ${getTrendColor()}`}>
            <span>{getTrendIcon()}</span>
            <span className="ml-1">{trendValue}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export const MetricsPanel: React.FC = () => {
  const { data: metrics, error, loading } = useApiData<Metrics>('/api/metrics');

  if (loading && !metrics) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-4">
        <h2 className="text-lg font-bold mb-4 text-white">Performance Metrics</h2>
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-4">
        <h2 className="text-lg font-bold mb-4 text-white">Performance Metrics</h2>
        <div className="text-red-500">Failed to load metrics.</div>
      </div>
    );
  }

  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  const formatSuccessRate = (rate: number) => {
    return `${(rate * 100).toFixed(1)}`;
  };

  return (
    <div className="bg-gray-800 rounded-lg shadow-md p-4">
      <h2 className="text-lg font-bold mb-4 text-white">Performance Metrics</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <MetricCard
          label="Total Issues Processed"
          value={metrics?.totalIssuesProcessed || 0}
          trend="up"
          trendValue="+12%"
        />
        <MetricCard
          label="Success Rate"
          value={formatSuccessRate(metrics?.successRate || 0)}
          unit="%"
          trend={metrics?.successRate && metrics.successRate > 0.9 ? 'up' : 'down'}
          trendValue={metrics?.successRate && metrics.successRate > 0.9 ? '+2%' : '-3%'}
        />
        <MetricCard
          label="Avg Processing Time"
          value={formatTime(metrics?.averageProcessingTime || 0)}
          trend="down"
          trendValue="-15%"
        />
        <MetricCard
          label="Active Repositories"
          value={metrics?.activeRepositories || 0}
          trend="stable"
          trendValue="0%"
        />
      </div>

      {metrics?.dailyStats && metrics.dailyStats.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-700">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">Daily Activity</h3>
          <div className="space-y-2">
            {metrics.dailyStats.slice(0, 7).map((stat) => (
              <div key={stat.date} className="flex items-center justify-between text-sm">
                <span className="text-gray-400">{new Date(stat.date).toLocaleDateString()}</span>
                <div className="flex space-x-4">
                  <span className="text-green-400">✓ {stat.successful}</span>
                  <span className="text-red-400">✗ {stat.failed}</span>
                  <span className="text-gray-300">Total: {stat.processed}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};