import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getTasks } from '../api/gitfixApi';

interface Task {
  id: string;
  repository?: string;
  issueNumber?: number;
  title?: string;
  status: string;
  createdAt: string;
  processedAt?: string;
  completedAt?: string;
}

interface TaskListProps {
  limit: number;
  showViewAll?: boolean;
}

interface LoadConfig {
  setLoadingState?: boolean;
}

const TaskList: React.FC<TaskListProps> = ({ limit, showViewAll = false }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    const fetchTasks = async (loadConfig?: LoadConfig) => {
      try {
        setLoading(loadConfig?.setLoadingState ?? true);
        const data = await getTasks(filter, limit);
        setTasks(data.tasks || []);
      } catch (err) {
        setError((err as Error).message);
        console.error('Error fetching tasks:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchTasks({ setLoadingState: true });
    const interval = setInterval(() => fetchTasks({ setLoadingState: false }), 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, [filter, limit]);

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'completed':
        return '#10B981';
      case 'failed':
        return '#EF4444';
      case 'active':
        return '#3B82F6';
      case 'waiting':
        return '#8b5cf6';
      default:
        return '#94A3B8';
    }
  };

  const getStatusDotClass = (status: string): string => {
    switch (status) {
      case 'completed':
        return 'bg-green-500';
      case 'failed':
        return 'bg-red-500';
      case 'active':
        return 'bg-blue-500 animate-pulse';
      case 'waiting':
        return 'bg-purple-500';
      default:
        return 'bg-gray-500';
    }
  };

  const formatDate = (dateString: string | undefined): string => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const formatDuration = (startTime: string | undefined, endTime: string | undefined, status: string): string => {
    if (!startTime) return 'N/A';
    
    // For active tasks, calculate duration from start time to now
    const end = endTime ? new Date(endTime) : new Date();
    const duration = end - new Date(startTime);
    
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);
    
    // Add indicator for active tasks
    const suffix = status === 'active' ? ' (running)' : '';
    return `${minutes}m ${seconds}s${suffix}`;
  };

  if (loading && tasks.length === 0) return <div className="bg-brand-component border border-brand-border rounded-lg p-6 text-brand-text-dim">Loading tasks...</div>;
  if (error) return <div className="bg-brand-component border border-brand-border rounded-lg p-6 text-brand-red">Error loading tasks: {error}</div>;

  return (
    <div className="bg-brand-component border border-brand-border rounded-lg p-6 mt-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-brand-text-light">Tasks</h3>
        <div className="flex items-center gap-4">
          <select 
            value={filter} 
            onChange={(e) => setFilter(e.target.value)}
            className="px-3 py-2 bg-brand-dark border border-brand-border text-brand-text-light rounded-md focus:ring-2 focus:ring-brand-accent focus:border-brand-accent cursor-pointer"
          >
            <option value="all">All Tasks</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="waiting">Waiting</option>
          </select>
          {showViewAll && (
            <Link to="/tasks" className="text-brand-accent hover:text-brand-accent-hover transition-colors">
              View All Tasks
            </Link>
          )}
        </div>
      </div>

      {tasks.length === 0 ? (
        <p className="text-brand-text-dim text-center py-8">No tasks found</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-brand-border">
                <th className="py-3 px-4 text-left text-sm font-medium text-brand-text-dim uppercase tracking-wider">Repository</th>
                <th className="py-3 px-4 text-left text-sm font-medium text-brand-text-dim uppercase tracking-wider">Issue/Task</th>
                <th className="py-3 px-4 text-left text-sm font-medium text-brand-text-dim uppercase tracking-wider">Status</th>
                <th className="py-3 px-4 text-left text-sm font-medium text-brand-text-dim uppercase tracking-wider">Created</th>
                <th className="py-3 px-4 text-left text-sm font-medium text-brand-text-dim uppercase tracking-wider">Duration</th>
                <th className="py-3 px-4 text-left text-sm font-medium text-brand-text-dim uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-brand-border">
              {tasks.map((task, index) => (
                <tr 
                  key={task.id}
                  className={`hover:bg-brand-border/50 transition-colors cursor-pointer ${
                    index % 2 === 0 ? 'bg-brand-component/50' : 'bg-brand-component/30'
                  }`}
                >
                  <td className="py-4 px-4 text-sm text-brand-text-light">
                    {task.repository || 'Unknown'}
                  </td>
                  <td className="py-4 px-4">
                    <div className="font-medium text-brand-text-light">
                      {task.id.startsWith('pr-comments-batch') ? 
                        `PR #${task.issueNumber || 'N/A'} Comments` : 
                        task.issueNumber ? `Issue #${task.issueNumber}` : 'Task'
                      }
                    </div>
                    {task.title && (
                      <div className="text-sm text-brand-text-dim mt-1">
                        {task.title.substring(0, 60)}
                        {task.title.length > 60 && '...'}
                      </div>
                    )}
                  </td>
                  <td className="py-4 px-4">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${getStatusDotClass(task.status)}`}></span>
                      <span className="text-sm font-medium capitalize" style={{ color: getStatusColor(task.status) }}>
                        {task.status}
                      </span>
                    </div>
                  </td>
                  <td className="py-4 px-4 text-sm text-brand-text-light">
                    {formatDate(task.createdAt)}
                  </td>
                  <td className="py-4 px-4 text-sm text-brand-text-light">
                    {formatDuration(task.processedAt || task.createdAt, task.completedAt, task.status)}
                  </td>
                  <td className="py-4 px-4">
                    <Link to={`/tasks/${task.id}`}>
                      <button className="px-3 py-1.5 bg-brand-accent hover:bg-brand-accent-hover text-white text-sm rounded-md transition-colors">
                        View Details
                      </button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default TaskList;