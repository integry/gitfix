import React from 'react';
import { useApiData } from '../hooks/useApiData';

interface LLMMetrics {
  summary: {
    totalRequests: number;
    totalSuccessful: number;
    totalFailed: number;
    successRate: number;
    totalCostUsd: number;
    avgCostPerRequest: number;
    totalTurns: number;
    avgTurnsPerRequest: number;
    avgExecutionTimeSec: number;
  };
  modelBreakdown: {
    [model: string]: {
      totalRequests: number;
      successful: number;
      failed: number;
      successRate: number;
      totalCostUsd: number;
      avgCostPerRequest: number;
      totalTurns: number;
      avgTurnsPerRequest: number;
      avgExecutionTimeSec: number;
    };
  };
  dailyMetrics: Array<{
    date: string;
    successful: number;
    failed: number;
    total: number;
    costUsd: number;
  }>;
  recentHighCostAlerts: Array<{
    timestamp: string;
    correlationId: string;
    issueNumber: number;
    repository: string;
    costUsd: number;
    threshold: number;
    model: string;
    numTurns: number;
  }>;
}

interface MetricCardProps {
  label: string;
  value: string | number;
  unit?: string;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

const MetricCard: React.FC<MetricCardProps> = ({ label, value, unit, variant = 'default' }) => {
  const variantColors = {
    default: 'bg-gray-700',
    success: 'bg-green-900',
    warning: 'bg-yellow-900',
    danger: 'bg-red-900'
  };

  return (
    <div className={`${variantColors[variant]} rounded-lg p-4`}>
      <div className="text-sm text-gray-400 mb-2">{label}</div>
      <div className="flex items-baseline">
        <span className="text-2xl font-bold text-white">{value}</span>
        {unit && <span className="text-sm text-gray-400 ml-1">{unit}</span>}
      </div>
    </div>
  );
};

export const LLMMetricsPanel: React.FC = () => {
  const { data: metrics, error, loading } = useApiData<LLMMetrics>('/api/llm-metrics');

  if (loading && !metrics) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-6">
        <h2 className="text-xl font-bold mb-4 text-white">LLM Performance Metrics</h2>
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-6">
        <h2 className="text-xl font-bold mb-4 text-white">LLM Performance Metrics</h2>
        <div className="text-red-500">Failed to load LLM metrics.</div>
      </div>
    );
  }

  const formatCost = (cost: number) => `$${cost.toFixed(2)}`;
  const formatPercent = (rate: number) => `${(rate * 100).toFixed(1)}`;
  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
  };

  return (
    <div className="bg-gray-800 rounded-lg shadow-md p-6">
      <h2 className="text-xl font-bold mb-4 text-white">LLM Performance Metrics</h2>
      
      {/* Summary Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <MetricCard
          label="Total Requests"
          value={metrics?.summary.totalRequests || 0}
        />
        <MetricCard
          label="Success Rate"
          value={formatPercent(metrics?.summary.successRate || 0)}
          unit="%"
          variant={metrics?.summary.successRate && metrics.summary.successRate > 0.8 ? 'success' : 'warning'}
        />
        <MetricCard
          label="Total Cost"
          value={formatCost(metrics?.summary.totalCostUsd || 0)}
          variant={metrics?.summary.totalCostUsd && metrics.summary.totalCostUsd > 100 ? 'warning' : 'default'}
        />
        <MetricCard
          label="Avg Cost/Request"
          value={formatCost(metrics?.summary.avgCostPerRequest || 0)}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <MetricCard
          label="Avg Turns/Request"
          value={(metrics?.summary.avgTurnsPerRequest || 0).toFixed(1)}
        />
        <MetricCard
          label="Avg Execution Time"
          value={formatTime(metrics?.summary.avgExecutionTimeSec || 0)}
        />
        <MetricCard
          label="Failed Requests"
          value={metrics?.summary.totalFailed || 0}
          variant={metrics?.summary.totalFailed && metrics.summary.totalFailed > 10 ? 'danger' : 'default'}
        />
      </div>

      {/* Model Breakdown */}
      {metrics?.modelBreakdown && Object.keys(metrics.modelBreakdown).length > 0 && (
        <div className="mt-6 pt-6 border-t border-gray-700">
          <h3 className="text-lg font-semibold text-gray-300 mb-4">Model Performance Breakdown</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-gray-400 uppercase bg-gray-700">
                <tr>
                  <th className="px-4 py-3">Model</th>
                  <th className="px-4 py-3 text-right">Requests</th>
                  <th className="px-4 py-3 text-right">Success Rate</th>
                  <th className="px-4 py-3 text-right">Total Cost</th>
                  <th className="px-4 py-3 text-right">Avg Cost</th>
                  <th className="px-4 py-3 text-right">Avg Time</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(metrics.modelBreakdown).map(([model, stats]) => (
                  <tr key={model} className="border-b border-gray-700">
                    <td className="px-4 py-3 font-medium text-white">{model}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{stats.totalRequests}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={stats.successRate > 0.8 ? 'text-green-400' : 'text-yellow-400'}>
                        {formatPercent(stats.successRate)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-300">{formatCost(stats.totalCostUsd)}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{formatCost(stats.avgCostPerRequest)}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{formatTime(stats.avgExecutionTimeSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent High Cost Alerts */}
      {metrics?.recentHighCostAlerts && metrics.recentHighCostAlerts.length > 0 && (
        <div className="mt-6 pt-6 border-t border-gray-700">
          <h3 className="text-lg font-semibold text-gray-300 mb-4">⚠️ Recent High Cost Alerts</h3>
          <div className="space-y-3">
            {metrics.recentHighCostAlerts.slice(0, 5).map((alert, index) => (
              <div key={`${alert.correlationId}-${index}`} className="bg-red-900 bg-opacity-20 border border-red-700 rounded-lg p-4">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="text-sm font-medium text-red-400">
                      Cost: {formatCost(alert.costUsd)} (threshold: {formatCost(alert.threshold)})
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                      {alert.repository} - Issue #{alert.issueNumber}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Model: {alert.model} | Turns: {alert.numTurns}
                    </div>
                  </div>
                  <div className="text-xs text-gray-500">
                    {new Date(alert.timestamp).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily Cost Trend */}
      {metrics?.dailyMetrics && metrics.dailyMetrics.length > 0 && (
        <div className="mt-6 pt-6 border-t border-gray-700">
          <h3 className="text-lg font-semibold text-gray-300 mb-4">Daily Cost Trend (Last 7 Days)</h3>
          <div className="space-y-2">
            {metrics.dailyMetrics.map((day) => (
              <div key={day.date} className="flex items-center justify-between text-sm">
                <span className="text-gray-400">{new Date(day.date).toLocaleDateString()}</span>
                <div className="flex items-center space-x-4">
                  <span className="text-green-400">✓ {day.successful}</span>
                  <span className="text-red-400">✗ {day.failed}</span>
                  <span className="text-white font-medium">{formatCost(day.costUsd)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};