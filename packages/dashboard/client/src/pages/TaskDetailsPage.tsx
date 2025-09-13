import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

interface TaskHistory {
  taskId: string;
  history: any[];
  logs: string | null;
  finalDiff: string | null;
}

interface LogMessage {
  type: 'log' | 'diff' | 'connected';
  channel?: string;
  data?: string;
  timestamp: string;
}

const TaskDetailsPage: React.FC = () => {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const { token } = useAuth();
  const [taskHistory, setTaskHistory] = useState<TaskHistory | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [currentDiff, setCurrentDiff] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  // Fetch task history data
  useEffect(() => {
    if (!taskId || !token) return;

    const fetchTaskHistory = async () => {
      try {
        const response = await fetch(`${import.meta.env.VITE_API_URL}/api/task/${taskId}/history`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (!response.ok) {
          throw new Error('Failed to fetch task history');
        }

        const data = await response.json();
        setTaskHistory(data);

        // Check if task is active (no logs means it might be running)
        if (!data.logs && data.history.length > 0) {
          const lastState = data.history[data.history.length - 1];
          if (lastState.state !== 'COMPLETED' && lastState.state !== 'FAILED') {
            setLiveMode(true);
          }
        }

        // If we have historical logs, display them
        if (data.logs) {
          setLogs(data.logs.split('\n'));
        }
        if (data.finalDiff) {
          setCurrentDiff(data.finalDiff);
        }

        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setLoading(false);
      }
    };

    fetchTaskHistory();
  }, [taskId, token]);

  // Set up WebSocket connection for live tasks
  useEffect(() => {
    if (!liveMode || !taskId || !token) return;

    const wsUrl = `${import.meta.env.VITE_API_URL.replace('http', 'ws')}/ws/tasks/${taskId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected for task:', taskId);
    };

    ws.onmessage = (event) => {
      try {
        const message: LogMessage = JSON.parse(event.data);
        
        if (message.type === 'log' && message.data) {
          setLogs(prev => [...prev, message.data!]);
          
          // Auto-scroll to bottom
          if (logsContainerRef.current) {
            logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
          }
        } else if (message.type === 'diff' && message.data) {
          setCurrentDiff(message.data);
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setError('WebSocket connection error');
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setLiveMode(false);
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [liveMode, taskId, token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-600">Loading task details...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-red-600">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <button
            onClick={() => navigate('/dashboard')}
            className="text-blue-600 hover:text-blue-800 flex items-center gap-2"
          >
            ← Back to Dashboard
          </button>
        </div>

        <div className="bg-white shadow rounded-lg p-6 mb-6">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">
            Task Details: {taskId}
          </h1>
          
          {liveMode && (
            <div className="mb-4 flex items-center gap-2">
              <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
              <span className="text-green-600 font-semibold">Live Streaming</span>
            </div>
          )}

          {taskHistory && taskHistory.history.length > 0 && (
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-800 mb-2">Task Status</h2>
              <div className="space-y-2">
                {taskHistory.history.slice(-5).map((entry, index) => (
                  <div key={index} className="flex items-center gap-4 text-sm">
                    <span className="text-gray-500">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                    <span className={`font-medium ${
                      entry.state === 'COMPLETED' ? 'text-green-600' :
                      entry.state === 'FAILED' ? 'text-red-600' :
                      'text-blue-600'
                    }`}>
                      {entry.state}
                    </span>
                    {entry.details && <span className="text-gray-600">{entry.details}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white shadow rounded-lg p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Execution Logs</h2>
            <div 
              ref={logsContainerRef}
              className="bg-gray-900 text-gray-100 p-4 rounded-md h-96 overflow-y-auto font-mono text-sm"
            >
              {logs.length > 0 ? (
                logs.map((log, index) => (
                  <div key={index} className="whitespace-pre-wrap">{log}</div>
                ))
              ) : (
                <div className="text-gray-500">No logs available yet...</div>
              )}
            </div>
          </div>

          <div className="bg-white shadow rounded-lg p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Git Diff</h2>
            <div className="bg-gray-900 text-gray-100 p-4 rounded-md h-96 overflow-y-auto font-mono text-sm">
              {currentDiff ? (
                <pre className="whitespace-pre-wrap">{currentDiff}</pre>
              ) : (
                <div className="text-gray-500">No changes detected yet...</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaskDetailsPage;