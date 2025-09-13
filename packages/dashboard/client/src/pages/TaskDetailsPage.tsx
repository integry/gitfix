import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
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
  claudeResult?: {
    success: boolean;
    sessionId: string;
    executionTime: number;
  };
  prResult?: {
    number: number;
    url: string;
  };
  history: Array<{
    state: string;
    timestamp: string;
    reason: string;
  }>;
}

interface TaskHistory {
  taskId: string;
  state: TaskState;
  logs: string;
  diff: string;
  history: Array<any>;
}

const TaskDetailsPage: React.FC = () => {
  const { taskId } = useParams<{ taskId: string }>();
  const [isLive, setIsLive] = useState(false);
  const [logs, setLogs] = useState<string>('');
  const [diff, setDiff] = useState<string>('');
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Fetch task history data
  const { data: taskHistory, loading, error } = useApiData<TaskHistory>(`/api/task/${taskId}/history`);

  // Determine if task is active
  useEffect(() => {
    if (taskHistory?.state) {
      const activeStates = ['pending', 'processing', 'claude_execution', 'post_processing'];
      setIsLive(activeStates.includes(taskHistory.state.state));
    }
  }, [taskHistory]);

  // Set up WebSocket connection for live tasks
  useEffect(() => {
    if (!isLive || !taskId) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.hostname}:${import.meta.env.VITE_API_PORT || 4000}/ws/tasks/${taskId}`;
    
    setWsStatus('connecting');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      console.log('WebSocket connected for task:', taskId);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
        switch (message.type) {
          case 'log':
            setLogs(prev => prev + message.data);
            // Auto-scroll to bottom
            setTimeout(() => {
              logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
            }, 100);
            break;
          case 'diff':
            setDiff(message.data);
            break;
          case 'status':
            const statusData = JSON.parse(message.data);
            if (statusData.status === 'completed' || statusData.status === 'failed') {
              setIsLive(false);
            }
            break;
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setWsStatus('disconnected');
    };

    ws.onclose = () => {
      setWsStatus('disconnected');
      console.log('WebSocket disconnected');
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [isLive, taskId]);

  // Load historical data if not live
  useEffect(() => {
    if (!isLive && taskHistory) {
      setLogs(taskHistory.logs || '');
      setDiff(taskHistory.diff || '');
    }
  }, [isLive, taskHistory]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white">Loading task details...</div>
      </div>
    );
  }

  if (error || !taskHistory) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-red-400">
          {error ? `Error: ${error.message}` : 'Task not found'}
        </div>
      </div>
    );
  }

  const { state } = taskHistory;

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Header */}
      <header className="bg-gray-800 shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div>
              <Link to="/" className="text-blue-400 hover:text-blue-300 mb-2 inline-block">
                ← Back to Dashboard
              </Link>
              <h1 className="text-2xl font-bold text-white">
                Task Details: {state.issueRef.repoOwner}/{state.issueRef.repoName} #{state.issueRef.number}
              </h1>
              <div className="flex items-center gap-4 mt-2">
                <span className={`px-3 py-1 rounded text-sm font-medium ${
                  state.state === 'completed' ? 'bg-green-600 text-white' :
                  state.state === 'failed' ? 'bg-red-600 text-white' :
                  state.state === 'processing' || state.state === 'claude_execution' ? 'bg-blue-600 text-white' :
                  'bg-gray-600 text-white'
                }`}>
                  {state.state.replace('_', ' ').toUpperCase()}
                </span>
                {isLive && (
                  <span className="flex items-center gap-2 text-sm text-gray-400">
                    <span className={`w-2 h-2 rounded-full ${
                      wsStatus === 'connected' ? 'bg-green-500' :
                      wsStatus === 'connecting' ? 'bg-yellow-500' :
                      'bg-red-500'
                    }`} />
                    {wsStatus === 'connected' ? 'Live' : wsStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
                  </span>
                )}
              </div>
            </div>
            {state.prResult && (
              <a
                href={state.prResult.url}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors"
              >
                View PR #{state.prResult.number}
              </a>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Task Info Panel */}
          <div className="lg:col-span-1">
            <div className="bg-gray-800 rounded-lg p-6">
              <h2 className="text-lg font-semibold text-white mb-4">Task Information</h2>
              <dl className="space-y-3">
                <div>
                  <dt className="text-gray-400 text-sm">Task ID</dt>
                  <dd className="text-white font-mono text-sm">{state.taskId}</dd>
                </div>
                <div>
                  <dt className="text-gray-400 text-sm">Created</dt>
                  <dd className="text-white text-sm">{new Date(state.createdAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-gray-400 text-sm">Last Updated</dt>
                  <dd className="text-white text-sm">{new Date(state.updatedAt).toLocaleString()}</dd>
                </div>
                {state.claudeResult && (
                  <>
                    <div>
                      <dt className="text-gray-400 text-sm">Execution Time</dt>
                      <dd className="text-white text-sm">
                        {Math.round(state.claudeResult.executionTime / 1000)}s
                      </dd>
                    </div>
                    <div>
                      <dt className="text-gray-400 text-sm">Session ID</dt>
                      <dd className="text-white font-mono text-xs">{state.claudeResult.sessionId}</dd>
                    </div>
                  </>
                )}
              </dl>

              {/* Task History */}
              <h3 className="text-lg font-semibold text-white mt-6 mb-3">History</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {state.history.map((entry, index) => (
                  <div key={index} className="border-l-2 border-gray-700 pl-3">
                    <div className="text-sm text-gray-400">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </div>
                    <div className="text-sm text-white font-medium">{entry.state}</div>
                    <div className="text-xs text-gray-500">{entry.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Logs Panel */}
          <div className="lg:col-span-2">
            <div className="bg-gray-800 rounded-lg p-6">
              <h2 className="text-lg font-semibold text-white mb-4">
                Execution Logs {isLive && <span className="text-sm text-gray-400 ml-2">(Live)</span>}
              </h2>
              <div className="bg-gray-900 rounded p-4 font-mono text-sm text-gray-300 overflow-x-auto max-h-96 overflow-y-auto">
                <pre className="whitespace-pre-wrap">{logs || 'No logs available yet...'}</pre>
                <div ref={logsEndRef} />
              </div>
            </div>

            {/* Git Diff Panel */}
            <div className="bg-gray-800 rounded-lg p-6 mt-6">
              <h2 className="text-lg font-semibold text-white mb-4">
                Git Changes {isLive && <span className="text-sm text-gray-400 ml-2">(Live)</span>}
              </h2>
              <div className="bg-gray-900 rounded p-4 font-mono text-sm overflow-x-auto max-h-96 overflow-y-auto">
                {diff ? (
                  <pre className="whitespace-pre-wrap">
                    {diff.split('\n').map((line, index) => (
                      <div
                        key={index}
                        className={
                          line.startsWith('+') && !line.startsWith('+++') ? 'text-green-400' :
                          line.startsWith('-') && !line.startsWith('---') ? 'text-red-400' :
                          line.startsWith('@@') ? 'text-blue-400' :
                          'text-gray-300'
                        }
                      >
                        {line}
                      </div>
                    ))}
                  </pre>
                ) : (
                  <div className="text-gray-500">No changes detected yet...</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default TaskDetailsPage;