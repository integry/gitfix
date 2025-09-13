import React from 'react';
import { Link } from 'react-router-dom';
import { useApiData } from '../hooks/useApiData';

interface Task {
  taskId: string;
  issueRef: {
    number: number;
    repoOwner: string;
    repoName: string;
  };
  state: string;
  createdAt: string;
  updatedAt: string;
  claudeResult?: {
    success: boolean;
    executionTime: number;
  };
  prResult?: {
    number: number;
    url: string;
  };
}

interface TasksResponse {
  tasks: Task[];
  total: number;
}

export const TasksList: React.FC = () => {
  const { data, loading, error } = useApiData<TasksResponse>('/api/tasks');

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-xl font-semibold text-white mb-4">Recent Tasks</h2>
        <div className="text-gray-400">Loading tasks...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-xl font-semibold text-white mb-4">Recent Tasks</h2>
        <div className="text-red-400">Failed to load tasks</div>
      </div>
    );
  }

  const getStateColor = (state: string) => {
    switch (state) {
      case 'completed':
        return 'text-green-400';
      case 'failed':
        return 'text-red-400';
      case 'processing':
      case 'claude_execution':
        return 'text-blue-400';
      case 'pending':
        return 'text-yellow-400';
      default:
        return 'text-gray-400';
    }
  };

  const getStateBadgeColor = (state: string) => {
    switch (state) {
      case 'completed':
        return 'bg-green-600';
      case 'failed':
        return 'bg-red-600';
      case 'processing':
      case 'claude_execution':
        return 'bg-blue-600';
      case 'pending':
        return 'bg-yellow-600';
      default:
        return 'bg-gray-600';
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h2 className="text-xl font-semibold text-white mb-4">
        Recent Tasks
        <span className="text-sm text-gray-400 ml-2">({data.total} total)</span>
      </h2>
      
      <div className="space-y-4">
        {data.tasks.length === 0 ? (
          <div className="text-gray-400">No tasks found</div>
        ) : (
          data.tasks.slice(0, 10).map((task) => (
            <Link
              key={task.taskId}
              to={`/tasks/${task.taskId}`}
              className="block bg-gray-700 hover:bg-gray-600 rounded-lg p-4 transition-colors"
            >
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <h3 className="text-white font-medium">
                      {task.issueRef.repoOwner}/{task.issueRef.repoName} #{task.issueRef.number}
                    </h3>
                    <span className={`px-2 py-1 rounded text-xs font-medium text-white ${getStateBadgeColor(task.state)}`}>
                      {task.state.replace('_', ' ').toUpperCase()}
                    </span>
                  </div>
                  
                  <div className="mt-2 flex items-center gap-4 text-sm text-gray-400">
                    <span>Created: {new Date(task.createdAt).toLocaleString()}</span>
                    {task.claudeResult && (
                      <span>
                        Time: {Math.round(task.claudeResult.executionTime / 1000)}s
                      </span>
                    )}
                    {task.prResult && (
                      <span className="text-blue-400">
                        PR #{task.prResult.number}
                      </span>
                    )}
                  </div>
                </div>
                
                <div className="ml-4">
                  <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
      
      {data.tasks.length > 10 && (
        <div className="mt-4 text-center">
          <span className="text-sm text-gray-400">
            Showing 10 of {data.total} tasks
          </span>
        </div>
      )}
    </div>
  );
};