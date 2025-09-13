import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Container, Card, Button, Badge, Spinner, Tabs, Tab } from 'react-bootstrap';
import { FaArrowLeft, FaSync, FaCode, FaTerminal } from 'react-icons/fa';
import { API_BASE_URL } from '../config';

function TaskDetailsPage() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const wsRef = useRef(null);
  
  const [task, setTask] = useState(null);
  const [logs, setLogs] = useState([]);
  const [diffs, setDiffs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isLive, setIsLive] = useState(false);
  const [activeTab, setActiveTab] = useState('logs');
  const [historicalData, setHistoricalData] = useState(null);
  
  const logsEndRef = useRef(null);

  const scrollToBottom = () => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [logs]);

  useEffect(() => {
    fetchTaskDetails();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [taskId]);

  const fetchTaskDetails = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/task/${taskId}`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch task details');
      }
      
      const data = await response.json();
      setTask(data.task);
      
      // Check if task is active
      if (data.task.state === 'processing' || data.task.state === 'pending') {
        setIsLive(true);
        connectWebSocket();
      } else {
        // Fetch historical data
        fetchHistoricalData();
      }
      
      setLoading(false);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  const fetchHistoricalData = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/history`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch historical data');
      }
      
      const data = await response.json();
      setHistoricalData(data);
      
      if (data.output) {
        setLogs([{ timestamp: data.data?.completedAt, message: data.output }]);
      }
      
      if (data.diff) {
        setDiffs([{ timestamp: data.data?.completedAt, diff: data.diff }]);
      }
    } catch (err) {
      console.error('Failed to fetch historical data:', err);
    }
  };

  const connectWebSocket = () => {
    const wsUrl = `${API_BASE_URL.replace('http', 'ws')}/ws/tasks/${taskId}`;
    const ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      console.log('WebSocket connected for task:', taskId);
    };
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case 'log':
          setLogs((prev) => [...prev, {
            timestamp: data.timestamp,
            message: data.message
          }]);
          break;
          
        case 'diff':
          setDiffs((prev) => [...prev, {
            timestamp: data.timestamp,
            diff: data.message
          }]);
          break;
          
        case 'state':
          setTask((prev) => ({
            ...prev,
            state: data.message.newState
          }));
          
          // If task completed, fetch historical data
          if (data.message.newState === 'completed' || data.message.newState === 'failed') {
            setIsLive(false);
            setTimeout(fetchHistoricalData, 1000);
          }
          break;
      }
    };
    
    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setIsLive(false);
    };
    
    wsRef.current = ws;
  };

  const formatTimestamp = (timestamp) => {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleString();
  };

  const getStateBadgeVariant = (state) => {
    switch (state) {
      case 'completed': return 'success';
      case 'failed': return 'danger';
      case 'processing': return 'primary';
      case 'pending': return 'warning';
      default: return 'secondary';
    }
  };

  if (loading) {
    return (
      <Container className="mt-5 text-center">
        <Spinner animation="border" />
        <p className="mt-3">Loading task details...</p>
      </Container>
    );
  }

  if (error) {
    return (
      <Container className="mt-5">
        <Card className="border-danger">
          <Card.Body>
            <h4 className="text-danger">Error</h4>
            <p>{error}</p>
            <Button variant="primary" onClick={() => navigate('/dashboard')}>
              <FaArrowLeft className="me-2" /> Back to Dashboard
            </Button>
          </Card.Body>
        </Card>
      </Container>
    );
  }

  return (
    <Container className="mt-4">
      <div className="d-flex justify-content-between align-items-center mb-4">
        <h2>Task Details</h2>
        <Button variant="outline-primary" onClick={() => navigate('/dashboard')}>
          <FaArrowLeft className="me-2" /> Back to Dashboard
        </Button>
      </div>

      {task && (
        <Card className="mb-4">
          <Card.Body>
            <div className="d-flex justify-content-between align-items-start">
              <div>
                <h4 className="mb-3">
                  {task.issueRef ? `Issue #${task.issueRef.number}` : `Task ${taskId}`}
                </h4>
                {task.issueRef && (
                  <p className="text-muted">
                    {task.issueRef.repoOwner}/{task.issueRef.repoName}
                  </p>
                )}
              </div>
              <div className="text-end">
                <Badge bg={getStateBadgeVariant(task.state)} className="mb-2">
                  {task.state}
                </Badge>
                {isLive && (
                  <div>
                    <Badge bg="info" className="ms-2">
                      <FaSync className="spin me-1" /> Live
                    </Badge>
                  </div>
                )}
              </div>
            </div>
            
            <div className="mt-3">
              <small className="text-muted">
                Started: {formatTimestamp(task.createdAt)}
              </small>
              {task.updatedAt && (
                <small className="text-muted ms-3">
                  Updated: {formatTimestamp(task.updatedAt)}
                </small>
              )}
            </div>
            
            {historicalData?.data && (
              <div className="mt-3">
                {historicalData.data.prUrl && (
                  <a 
                    href={historicalData.data.prUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="btn btn-sm btn-success"
                  >
                    View Pull Request
                  </a>
                )}
                {historicalData.data.executionTime && (
                  <span className="ms-3 text-muted">
                    Execution time: {(historicalData.data.executionTime / 1000).toFixed(2)}s
                  </span>
                )}
              </div>
            )}
          </Card.Body>
        </Card>
      )}

      <Card>
        <Card.Header>
          <Tabs activeKey={activeTab} onSelect={setActiveTab}>
            <Tab eventKey="logs" title={<><FaTerminal className="me-2" />Logs</>} />
            <Tab eventKey="diff" title={<><FaCode className="me-2" />Diff</>} />
          </Tabs>
        </Card.Header>
        <Card.Body>
          {activeTab === 'logs' && (
            <div className="log-viewer">
              {logs.length === 0 ? (
                <p className="text-muted">No logs available yet...</p>
              ) : (
                <pre className="log-content">
                  {logs.map((log, index) => (
                    <div key={index} className="log-entry">
                      {log.message}
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </pre>
              )}
            </div>
          )}
          
          {activeTab === 'diff' && (
            <div className="diff-viewer">
              {diffs.length === 0 ? (
                <p className="text-muted">No diff available yet...</p>
              ) : (
                <pre className="diff-content">
                  {diffs[diffs.length - 1].diff}
                </pre>
              )}
            </div>
          )}
        </Card.Body>
      </Card>

      <style jsx>{`
        .log-viewer, .diff-viewer {
          max-height: 600px;
          overflow-y: auto;
          background-color: #1e1e1e;
          color: #d4d4d4;
          padding: 1rem;
          border-radius: 0.25rem;
        }
        
        .log-content, .diff-content {
          margin: 0;
          font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
          font-size: 0.875rem;
          white-space: pre-wrap;
          word-wrap: break-word;
        }
        
        .log-entry {
          padding: 0.25rem 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .log-entry:last-child {
          border-bottom: none;
        }
        
        .spin {
          animation: spin 2s linear infinite;
        }
        
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </Container>
  );
}

export default TaskDetailsPage;