import React from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useEffect, useState } from 'react';

interface TaskInfo {
  taskId: string;
  status: string;
  repository: string;
  issueNumber: number;
  createdAt: string;
  updatedAt: string;
}

export const ActiveTasksPanel: React.FC = () => {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

  useEffect(() => {
    const fetchActiveTasks = async () => {
      try {
        // Get all worker states from Redis
        const response = await axios.get(`${API_BASE_URL}/api/worker/states`, {
          withCredentials: true
        });
        
        if (response.data && response.data.tasks) {
          setTasks(response.data.tasks);
        }
        setError(null);
      } catch (err: any) {
        console.error('Error fetching active tasks:', err);
        setError(err.response?.data?.error || 'Failed to fetch active tasks');
      } finally {
        setLoading(false);
      }
    };

    fetchActiveTasks();
    const interval = setInterval(fetchActiveTasks, 5000); // Poll every 5 seconds

    return () => clearInterval(interval);
  }, [API_BASE_URL]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return 'bg-green-600';
      case 'FAILED':
        return 'bg-red-600';
      case 'PROCESSING':
      case 'CLAUDE_EXECUTION':
        return 'bg-blue-600';
      case 'PENDING':
        return 'bg-yellow-600';
      default:
        return 'bg-gray-600';
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

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-4">
        <h2 className="text-lg font-bold mb-4 text-white">Active Tasks</h2>
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-4">
        <h2 className="text-lg font-bold mb-4 text-white">Active Tasks</h2>
        <div className="text-red-500">Failed to load active tasks.</div>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg shadow-md p-4">
      <h2 className="text-lg font-bold mb-4 text-white">Active Tasks</h2>
      <div className="space-y-3 max-h-96 overflow-y-auto">
        {tasks && tasks.length > 0 ? (
          tasks.map((task) => (
            <Link
              key={task.taskId}
              to={`/task/${task.taskId}`}
              className="block bg-gray-700 hover:bg-gray-600 rounded-lg p-3 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-white truncate">
                  {task.repository} #{task.issueNumber}
                </span>
                <span className={`px-2 py-1 text-xs rounded ${getStatusColor(task.status)} text-white`}>
                  {task.status}
                </span>
              </div>
              <div className="text-xs text-gray-400">
                Started {formatTime(task.createdAt)}
              </div>
            </Link>
          ))
        ) : (
          <div className="text-gray-400 text-center py-8">
            No active tasks
          </div>
        )}
      </div>
    </div>
  );
};