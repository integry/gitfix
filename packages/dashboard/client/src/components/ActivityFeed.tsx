import React from 'react';
import { useApiData } from '../hooks/useApiData';
import { Link } from 'react-router-dom';

interface ActivityEvent {
  id: string;
  type: string;
  timestamp: string;
  user?: string;
  repository?: string;
  issueNumber?: number;
  description: string;
  status?: 'success' | 'error' | 'warning' | 'info';
  taskId?: string;
}

interface ActivityEventItemProps {
  event: ActivityEvent;
}

const ActivityEventItem: React.FC<ActivityEventItemProps> = ({ event }) => {
  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'success':
        return 'text-green-400';
      case 'error':
        return 'text-red-400';
      case 'warning':
        return 'text-yellow-400';
      default:
        return 'text-blue-400';
    }
  };

  const getEventIcon = (type: string) => {
    switch (type) {
      case 'issue_created':
      case 'issue_updated':
        return '📝';
      case 'pr_created':
      case 'pr_merged':
        return '🔀';
      case 'build_started':
      case 'build_completed':
        return '🏗️';
      case 'error':
        return '❌';
      default:
        return '📌';
    }
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  };

  return (
    <div className="flex items-start space-x-3 py-3 px-2 hover:bg-gray-700 rounded transition-colors">
      <span className="text-xl">{getEventIcon(event.type)}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <p className={`text-sm ${getStatusColor(event.status)}`}>
            {event.description}
          </p>
          <span className="text-xs text-gray-500 whitespace-nowrap ml-2">
            {formatTime(event.timestamp)}
          </span>
        </div>
        {(event.repository || event.user || event.taskId) && (
          <div className="mt-1 text-xs text-gray-400 flex items-center gap-2">
            {event.repository && <span>📁 {event.repository}</span>}
            {event.user && <span>👤 {event.user}</span>}
            {event.issueNumber && <span>#{event.issueNumber}</span>}
            {event.taskId && (
              <Link 
                to={`/task/${event.taskId}`} 
                className="text-blue-400 hover:text-blue-300 underline"
              >
                View Task Details →
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const ActivityFeed: React.FC = () => {
  const { data: events, error, loading } = useApiData<ActivityEvent[]>('/api/activity', {
    pollingInterval: 10000, // Poll every 10 seconds for activity updates
  });

  if (loading && !events) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-4">
        <h2 className="text-lg font-bold mb-4 text-white">Recent Activity</h2>
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-4">
        <h2 className="text-lg font-bold mb-4 text-white">Recent Activity</h2>
        <div className="text-red-500">Failed to load activity feed.</div>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg shadow-md p-4">
      <h2 className="text-lg font-bold mb-4 text-white">Recent Activity</h2>
      <div className="divide-y divide-gray-700 max-h-96 overflow-y-auto">
        {events && events.length > 0 ? (
          events.map((event) => (
            <ActivityEventItem key={event.id} event={event} />
          ))
        ) : (
          <div className="text-gray-400 text-center py-8">
            No recent activity
          </div>
        )}
      </div>
    </div>
  );
};