import React from 'react';
import { Link } from 'react-router-dom';
import { useApiData } from '../hooks/useApiData';

interface TaskState {
  taskId: string;
  issueRef: {
    number: number;
    repoOwner: string;
    repoName: string;
  };
  state: string;
  createdAt: string;
  updatedAt: string;
  prResult?: {
    number: number;
    url: string;
  };
}

export const TasksPanel: React.FC = () => {
  const { data: tasksResponse, error, loading } = useApiData<{tasks: TaskState[]}>('/api/tasks', {
    pollingInterval: 30000, // Poll every 30 seconds
  });

  const tasks = tasksResponse?.tasks || [];

  const getStateColor = (state: string) => {
    switch (state) {
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      case 'processing':
      case 'claude_execution':
      case 'post_processing':
        return 'bg-yellow-100 text-yellow-800';
      case 'pending':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-blue-100 text-blue-800';
    }
  };

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  if (loading && !tasks.length) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-lg font-bold mb-4">Recent Tasks</h2>
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-lg font-bold mb-4">Recent Tasks</h2>
        <div className="text-red-500">Failed to load tasks.</div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h2 className="text-lg font-bold mb-4">Recent Tasks</h2>
      <div className="space-y-3 max-h-96 overflow-y-auto">
        {tasks.length > 0 ? (
          tasks.map((task) => (
            <Link
              key={task.taskId}
              to={`/task/${task.taskId}`}
              className="block p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStateColor(task.state)}`}>
                      {task.state}
                    </span>
                    <span className="text-sm font-medium text-gray-900">
                      {task.issueRef.repoOwner}/{task.issueRef.repoName}#{task.issueRef.number}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Task ID: {task.taskId}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Started: {formatTime(task.createdAt)}
                  </div>
                  {task.prResult && (
                    <div className="mt-1 text-xs text-blue-600">
                      PR #{task.prResult.number} created
                    </div>
                  )}
                </div>
                <div className="ml-4">
                  <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </div>
            </Link>
          ))
        ) : (
          <div className="text-gray-400 text-center py-8">
            No tasks found
          </div>
        )}
      </div>
    </div>
  );
};