import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

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
}

interface TaskHistory {
  completedAt: string;
  logs: string;
  finalDiff: string;
  claudeResult?: any;
}

interface WebSocketMessage {
  type: 'log' | 'diff';
  taskId: string;
  message: string;
  timestamp: string;
}

export default function TaskDetailsPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const { token } = useAuth();
  const [taskState, setTaskState] = useState<TaskState | null>(null);
  const [taskHistory, setTaskHistory] = useState<TaskHistory | null>(null);
  const [liveLog, setLiveLog] = useState<string>('');
  const [liveDiff, setLiveDiff] = useState<string>('');
  const [isConnected, setIsConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Fetch task state
  useEffect(() => {
    if (!taskId) return;

    const fetchTaskData = async () => {
      try {
        // Fetch task state from worker state manager
        const stateResponse = await fetch(`${import.meta.env.VITE_API_URL}/api/task/${taskId}/state`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (stateResponse.ok) {
          const state = await stateResponse.json();
          setTaskState(state);
        }

        // If task is completed or failed, fetch historical data
        if (taskState?.state === 'completed' || taskState?.state === 'failed') {
          const historyResponse = await fetch(`${import.meta.env.VITE_API_URL}/api/task/${taskId}/history`, {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });

          if (historyResponse.ok) {
            const history = await historyResponse.json();
            setTaskHistory(history);
          }
        }

        setLoading(false);
      } catch (err) {
        console.error('Error fetching task data:', err);
        setError('Failed to load task data');
        setLoading(false);
      }
    };

    fetchTaskData();
  }, [taskId, token, taskState?.state]);

  // WebSocket connection for live tasks
  useEffect(() => {
    if (!taskId || !taskState || taskState.state === 'completed' || taskState.state === 'failed') {
      return;
    }

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${import.meta.env.VITE_API_URL.replace(/^https?:\/\//, '')}`;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      setIsConnected(true);
      
      // Subscribe to task channels
      ws.send(JSON.stringify({
        type: 'subscribe',
        taskId: taskId
      }));
    };

    ws.onmessage = (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);
        
        if (message.type === 'log') {
          setLiveLog(prev => prev + message.message);
        } else if (message.type === 'diff') {
          setLiveDiff(message.message);
        }
      } catch (err) {
        console.error('Error parsing WebSocket message:', err);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setIsConnected(false);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setIsConnected(false);
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'unsubscribe',
          taskId: taskId
        }));
      }
      ws.close();
    };
  }, [taskId, taskState]);

  // Auto-scroll to bottom of logs
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [liveLog]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-7xl mx-auto">
          <div className="animate-pulse">Loading task details...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-7xl mx-auto">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-800">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  const isLive = taskState && ['pending', 'processing', 'claude_execution', 'post_processing'].includes(taskState.state);
  const displayLogs = isLive ? liveLog : taskHistory?.logs || '';
  const displayDiff = isLive ? liveDiff : taskHistory?.finalDiff || '';

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <button
          onClick={() => navigate(-1)}
          className="mb-6 text-blue-600 hover:text-blue-800 flex items-center gap-2"
        >
          ← Back
        </button>

        <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
          <h1 className="text-2xl font-bold mb-4">Task Details: {taskId}</h1>
          
          {taskState && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div>
                <p className="text-sm text-gray-500">Status</p>
                <p className="font-semibold">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    taskState.state === 'completed' ? 'bg-green-100 text-green-800' :
                    taskState.state === 'failed' ? 'bg-red-100 text-red-800' :
                    'bg-yellow-100 text-yellow-800'
                  }`}>
                    {taskState.state}
                  </span>
                </p>
              </div>
              
              <div>
                <p className="text-sm text-gray-500">Issue</p>
                <p className="font-semibold">
                  <a 
                    href={`https://github.com/${taskState.issueRef.repoOwner}/${taskState.issueRef.repoName}/issues/${taskState.issueRef.number}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:text-blue-800"
                  >
                    #{taskState.issueRef.number}
                  </a>
                </p>
              </div>
              
              <div>
                <p className="text-sm text-gray-500">Repository</p>
                <p className="font-semibold text-sm">
                  {taskState.issueRef.repoOwner}/{taskState.issueRef.repoName}
                </p>
              </div>
              
              {taskState.prResult && (
                <div>
                  <p className="text-sm text-gray-500">Pull Request</p>
                  <p className="font-semibold">
                    <a 
                      href={taskState.prResult.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800"
                    >
                      #{taskState.prResult.number}
                    </a>
                  </p>
                </div>
              )}
            </div>
          )}

          {isLive && (
            <div className="mb-4 flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'} animate-pulse`}></div>
              <span className="text-sm text-gray-600">
                {isConnected ? 'Live - Streaming updates' : 'Disconnected - Attempting to reconnect...'}
              </span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-lg shadow-sm p-6">
            <h2 className="text-lg font-semibold mb-4">
              {isLive ? 'Live Logs' : 'Task Logs'}
            </h2>
            <div className="bg-gray-900 text-gray-100 p-4 rounded-lg h-96 overflow-y-auto font-mono text-sm">
              <pre className="whitespace-pre-wrap">{displayLogs || 'No logs available'}</pre>
              <div ref={logEndRef} />
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm p-6">
            <h2 className="text-lg font-semibold mb-4">
              {isLive ? 'Live Git Diff' : 'Final Git Diff'}
            </h2>
            <div className="bg-gray-900 text-gray-100 p-4 rounded-lg h-96 overflow-y-auto font-mono text-sm">
              <pre className="whitespace-pre-wrap">{displayDiff || 'No changes detected'}</pre>
            </div>
          </div>
        </div>

        {taskState?.claudeResult && (
          <div className="bg-white rounded-lg shadow-sm p-6 mt-6">
            <h2 className="text-lg font-semibold mb-4">Claude Execution Details</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <p className="text-sm text-gray-500">Success</p>
                <p className="font-semibold">
                  {taskState.claudeResult.success ? '✅ Yes' : '❌ No'}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Execution Time</p>
                <p className="font-semibold">
                  {Math.round(taskState.claudeResult.executionTime / 1000)}s
                </p>
              </div>
              {taskState.claudeResult.sessionId && (
                <div>
                  <p className="text-sm text-gray-500">Session ID</p>
                  <p className="font-semibold text-xs">
                    {taskState.claudeResult.sessionId}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}