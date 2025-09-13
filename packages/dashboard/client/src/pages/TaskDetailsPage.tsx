import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';

interface TaskState {
  taskId: string;
  status: string;
  repository: string;
  issueNumber: number;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  metadata?: any;
}

interface TaskHistory {
  taskId: string;
  history: any[];
  logs: string | null;
  finalDiff: string | null;
}

const TaskDetailsPage = () => {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [taskState, setTaskState] = useState<TaskState | null>(null);
  const [taskHistory, setTaskHistory] = useState<TaskHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [liveOutput, setLiveOutput] = useState<string>('');
  const [liveDiff, setLiveDiff] = useState<string>('');
  const [liveStatus, setLiveStatus] = useState<string>('');
  const wsRef = useRef<WebSocket | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

  // Fetch task details
  useEffect(() => {
    const fetchTaskData = async () => {
      try {
        setLoading(true);
        
        // Fetch task state
        const stateResponse = await axios.get(`${API_BASE_URL}/api/task/${taskId}`, {
          withCredentials: true
        });
        
        const state = stateResponse.data.state;
        setTaskState(state);
        
        // Check if task is active
        const activeStatuses = ['PENDING', 'PROCESSING', 'CLAUDE_EXECUTION'];
        setIsLive(activeStatuses.includes(state.status));
        
        // If task is completed, fetch historical data
        if (!activeStatuses.includes(state.status)) {
          const historyResponse = await axios.get(`${API_BASE_URL}/api/task/${taskId}/history`, {
            withCredentials: true
          });
          setTaskHistory(historyResponse.data);
        }
        
        setError(null);
      } catch (err: any) {
        console.error('Error fetching task data:', err);
        setError(err.response?.data?.error || 'Failed to fetch task data');
      } finally {
        setLoading(false);
      }
    };

    if (taskId) {
      fetchTaskData();
    }
  }, [taskId, API_BASE_URL]);

  // WebSocket connection for live tasks
  useEffect(() => {
    if (!isLive || !taskId) return;

    const wsUrl = API_BASE_URL.replace('http://', 'ws://').replace('https://', 'wss://');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      ws.send(JSON.stringify({ type: 'subscribe', taskId }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'subscribed') {
          console.log('Subscribed to task:', data.taskId);
        } else if (data.type === 'data') {
          if (data.channel.includes('task-log')) {
            const logData = JSON.parse(data.data);
            setLiveOutput(prev => prev + logData.data);
            
            // Auto-scroll to bottom
            if (outputRef.current) {
              outputRef.current.scrollTop = outputRef.current.scrollHeight;
            }
          } else if (data.channel.includes('task-diff')) {
            const diffData = JSON.parse(data.data);
            setLiveDiff(diffData.data);
          } else if (data.channel.includes('task-status')) {
            const statusData = JSON.parse(data.data);
            setLiveStatus(statusData.status);
            
            // If task completed, refresh task data
            if (statusData.status === 'claude_completed' || statusData.status === 'claude_failed') {
              setIsLive(false);
              window.location.reload(); // Simple refresh to get historical data
            }
          }
        }
      } catch (err) {
        console.error('WebSocket message error:', err);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'unsubscribe', taskId }));
      }
      ws.close();
    };
  }, [isLive, taskId, API_BASE_URL]);

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return 'text-green-600';
      case 'FAILED':
        return 'text-red-600';
      case 'PROCESSING':
      case 'CLAUDE_EXECUTION':
        return 'text-blue-600';
      default:
        return 'text-gray-600';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-xl">Loading task details...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <h3 className="text-red-800 font-semibold">Error</h3>
          <p className="text-red-700">{error}</p>
        </div>
        <button
          onClick={() => navigate('/')}
          className="mt-4 px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
        >
          Back to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <button
          onClick={() => navigate('/')}
          className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
        >
          ← Back to Dashboard
        </button>
      </div>

      {/* Task Header */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h1 className="text-2xl font-bold mb-4">Task Details: {taskId}</h1>
        
        {taskState && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-gray-600">Status</p>
              <p className={`font-semibold ${getStatusColor(taskState.status)}`}>
                {liveStatus || taskState.status}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Repository</p>
              <p className="font-mono">{taskState.repository}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Issue Number</p>
              <p className="font-mono">#{taskState.issueNumber}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Created</p>
              <p>{formatTimestamp(taskState.createdAt)}</p>
            </div>
          </div>
        )}
      </div>

      {/* Live Output */}
      {isLive && (
        <div className="bg-gray-900 rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-bold text-white mb-4">Live Output</h2>
          <pre
            ref={outputRef}
            className="bg-black text-green-400 p-4 rounded font-mono text-sm overflow-auto max-h-96"
          >
            {liveOutput || 'Waiting for output...'}
          </pre>
        </div>
      )}

      {/* Live Diff */}
      {isLive && liveDiff && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-bold mb-4">Current Changes</h2>
          <pre className="bg-gray-50 p-4 rounded font-mono text-sm overflow-auto max-h-96">
            {liveDiff}
          </pre>
        </div>
      )}

      {/* Historical Data */}
      {!isLive && taskHistory && (
        <>
          {/* Logs */}
          {taskHistory.logs && (
            <div className="bg-gray-900 rounded-lg shadow p-6 mb-6">
              <h2 className="text-xl font-bold text-white mb-4">Execution Logs</h2>
              <pre className="bg-black text-gray-300 p-4 rounded font-mono text-sm overflow-auto max-h-96">
                {taskHistory.logs}
              </pre>
            </div>
          )}

          {/* Final Diff */}
          {taskHistory.finalDiff && (
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <h2 className="text-xl font-bold mb-4">Final Changes</h2>
              <pre className="bg-gray-50 p-4 rounded font-mono text-sm overflow-auto max-h-96">
                {taskHistory.finalDiff}
              </pre>
            </div>
          )}

          {/* Task History */}
          {taskHistory.history && taskHistory.history.length > 0 && (
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-xl font-bold mb-4">Task History</h2>
              <div className="space-y-2">
                {taskHistory.history.map((entry, index) => (
                  <div key={index} className="border-l-2 border-gray-200 pl-4 py-2">
                    <p className="font-semibold">{entry.status}</p>
                    <p className="text-sm text-gray-600">{formatTimestamp(entry.timestamp)}</p>
                    {entry.message && <p className="text-sm mt-1">{entry.message}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default TaskDetailsPage;