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
  lastUpdated: string;
  history: Array<{
    state: string;
    timestamp: string;
    details?: string;
  }>;
}

export const TasksList: React.FC = () => {
  const { data: tasks, error, loading } = useApiData<TaskState[]>('/api/tasks/recent', {
    pollingInterval: 5000, // Poll every 5 seconds for updates
  });

  const getStateColor = (state: string) => {
    switch (state) {
      case 'COMPLETED':
        return 'bg-green-500';
      case 'FAILED':
        return 'bg-red-500';
      case 'PROCESSING':
      case 'CLAUDE_EXECUTION':
        return 'bg-blue-500';
      case 'POST_PROCESSING':
        return 'bg-yellow-500';
      default:
        return 'bg-gray-500';
    }
  };

  const getStateText = (state: string) => {
    switch (state) {
      case 'CLAUDE_EXECUTION':
        return 'Executing';
      case 'POST_PROCESSING':
        return 'Finalizing';
      default:
        return state.charAt(0) + state.slice(1).toLowerCase();
    }
  };

  if (loading && !tasks) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-4">
        <h2 className="text-lg font-bold mb-4 text-white">Recent Tasks</h2>
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800 rounded-lg shadow-md p-4">
        <h2 className="text-lg font-bold mb-4 text-white">Recent Tasks</h2>
        <div className="text-red-500">Failed to load tasks.</div>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg shadow-md p-4">
      <h2 className="text-lg font-bold mb-4 text-white">Recent Tasks</h2>
      <div className="space-y-3 max-h-96 overflow-y-auto">
        {tasks && tasks.length > 0 ? (
          tasks.map((task) => (
            <Link
              key={task.taskId}
              to={`/task/${task.taskId}`}
              className="block bg-gray-700 hover:bg-gray-600 rounded-lg p-3 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium">
                      {task.issueRef.repoOwner}/{task.issueRef.repoName} #{task.issueRef.number}
                    </span>
                    <span className={`px-2 py-1 rounded text-xs font-medium text-white ${getStateColor(task.state)}`}>
                      {getStateText(task.state)}
                    </span>
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    {new Date(task.lastUpdated).toLocaleString()}
                  </div>
                </div>
                <div className="text-gray-400">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </div>
            </Link>
          ))
        ) : (
          <div className="text-gray-400 text-center py-8">
            No recent tasks
          </div>
        )}
      </div>
    </div>
  );
};