import { useState, useEffect } from 'react';
import { getTaskHistory } from '../api/gitfixApi';

const TaskDetails = ({ taskId, onBack }) => {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedPrompt, setSelectedPrompt] = useState(null);
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [logFiles, setLogFiles] = useState(null);
  const [selectedLogFile, setSelectedLogFile] = useState(null);
  const [loadingLogFile, setLoadingLogFile] = useState(false);

  useEffect(() => {
    const fetchHistory = async () => {
      if (!taskId) return;
      
      try {
        setLoading(true);
        const data = await getTaskHistory(taskId);
        setHistory(data.history || []);
      } catch (err) {
        setError(err.message);
        console.error('Error fetching task history:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [taskId]);

  const fetchPrompt = async (sessionId, conversationId) => {
    try {
      setLoadingPrompt(true);
      const API_BASE_URL = 'https://api.gitfix.dev';
      const response = await fetch(
        `${API_BASE_URL}/api/execution/${sessionId}/prompt${conversationId ? `?conversationId=${conversationId}` : ''}`,
        { credentials: 'include' }
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch prompt');
      }
      
      const data = await response.json();
      setSelectedPrompt(data);
    } catch (err) {
      console.error('Error fetching prompt:', err);
      alert('Failed to fetch prompt: ' + err.message);
    } finally {
      setLoadingPrompt(false);
    }
  };

  const fetchLogFiles = async (sessionId, conversationId) => {
    try {
      const API_BASE_URL = 'https://api.gitfix.dev';
      const response = await fetch(
        `${API_BASE_URL}/api/execution/${sessionId}/logs${conversationId ? `?conversationId=${conversationId}` : ''}`,
        { credentials: 'include' }
      );
      
      if (!response.ok) {
        if (response.status === 404) {
          // Log files not found, but don't alert
          return;
        }
        throw new Error('Failed to fetch log files');
      }
      
      const data = await response.json();
      setLogFiles(data);
    } catch (err) {
      console.error('Error fetching log files:', err);
    }
  };

  const viewLogFile = async (sessionId, conversationId, type) => {
    try {
      setLoadingLogFile(true);
      const API_BASE_URL = 'https://api.gitfix.dev';
      const response = await fetch(
        `${API_BASE_URL}/api/execution/${sessionId}/logs/${type}${conversationId ? `?conversationId=${conversationId}` : ''}`,
        { credentials: 'include' }
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch log file');
      }
      
      const contentType = response.headers.get('content-type');
      let content;
      
      if (contentType?.includes('application/json')) {
        content = await response.json();
      } else {
        content = await response.text();
      }
      
      setSelectedLogFile({
        type,
        content,
        isJson: contentType?.includes('application/json')
      });
    } catch (err) {
      console.error('Error fetching log file:', err);
      alert('Failed to fetch log file: ' + err.message);
    } finally {
      setLoadingLogFile(false);
    }
  };

  const getStateColor = (state) => {
    switch (state) {
      case 'COMPLETED':
        return '#22c55e';
      case 'FAILED':
        return '#ef4444';
      case 'PROCESSING':
      case 'CLAUDE_EXECUTION':
        return '#3b82f6';
      case 'POST_PROCESSING':
        return '#a855f7';
      case 'PENDING':
        return '#6b7280';
      default:
        return '#6b7280';
    }
  };

  const formatTimestamp = (timestamp) => {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const formatDuration = (duration) => {
    if (!duration) return 'N/A';
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  };

  if (loading) return <div>Loading task history...</div>;
  if (error) return <div>Error loading task history: {error}</div>;

  return (
    <div style={{
      border: '1px solid #e5e7eb',
      borderRadius: '8px',
      padding: '1.5rem',
      backgroundColor: '#ffffff',
      marginTop: '1rem'
    }}>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        marginBottom: '1rem'
      }}>
        <h3>Task History: {taskId}</h3>
        <button
          onClick={onBack}
          style={{
            padding: '0.5rem 1rem',
            backgroundColor: '#6b7280',
            color: '#ffffff',
            borderRadius: '4px',
            border: 'none',
            cursor: 'pointer'
          }}
        >
          Back to Tasks
        </button>
      </div>

      {history.length === 0 ? (
        <p style={{ color: '#6b7280', textAlign: 'center' }}>No history found for this task</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {history.map((entry, index) => (
            <div 
              key={index}
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
                padding: '1rem',
                backgroundColor: '#f9fafb'
              }}
            >
              <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: '0.5rem'
              }}>
                <h4 style={{ 
                  color: getStateColor(entry.state),
                  margin: 0
                }}>
                  {entry.state || 'Unknown State'}
                </h4>
                <span style={{ fontSize: '0.875rem', color: '#6b7280' }}>
                  {formatTimestamp(entry.timestamp)}
                </span>
              </div>

              {entry.message && (
                <p style={{ margin: '0.5rem 0', color: '#374151' }}>
                  {entry.message}
                </p>
              )}

              {entry.metadata && (
                <div style={{ 
                  marginTop: '0.5rem',
                  fontSize: '0.875rem',
                  color: '#6b7280'
                }}>
                  {entry.metadata.duration && (
                    <div>Duration: {formatDuration(entry.metadata.duration)}</div>
                  )}
                  {entry.metadata.error && (
                    <div style={{ 
                      marginTop: '0.5rem',
                      padding: '0.5rem',
                      backgroundColor: '#fee2e2',
                      borderRadius: '4px',
                      color: '#991b1b'
                    }}>
                      Error: {entry.metadata.error}
                    </div>
                  )}
                  {entry.metadata.claudeResult && (
                    <div style={{ marginTop: '0.5rem' }}>
                      <div>Claude Execution: {entry.metadata.claudeResult.success ? 'Success' : 'Failed'}</div>
                      {entry.metadata.claudeResult.executionTime && (
                        <div>Execution Time: {formatDuration(entry.metadata.claudeResult.executionTime)}</div>
                      )}
                      {entry.metadata.claudeResult.model && (
                        <div>Model: {entry.metadata.claudeResult.model}</div>
                      )}
                    </div>
                  )}
                  {(entry.state === 'CLAUDE_EXECUTION' || entry.state === 'CLAUDE_COMPLETED') && 
                   (entry.metadata?.sessionId || entry.metadata?.conversationId) && (
                    <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
                      <button
                        onClick={() => fetchPrompt(entry.metadata.sessionId, entry.metadata.conversationId)}
                        style={{
                          padding: '0.25rem 0.75rem',
                          backgroundColor: '#3b82f6',
                          color: '#ffffff',
                          borderRadius: '4px',
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: '0.875rem'
                        }}
                        disabled={loadingPrompt}
                      >
                        {loadingPrompt ? 'Loading...' : 'View Prompt'}
                      </button>
                      <button
                        onClick={() => {
                          fetchLogFiles(entry.metadata.sessionId, entry.metadata.conversationId);
                          // Store session info for later use
                          window._currentSessionInfo = {
                            sessionId: entry.metadata.sessionId,
                            conversationId: entry.metadata.conversationId
                          };
                        }}
                        style={{
                          padding: '0.25rem 0.75rem',
                          backgroundColor: '#10b981',
                          color: '#ffffff',
                          borderRadius: '4px',
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: '0.875rem'
                        }}
                      >
                        View Logs
                      </button>
                    </div>
                  )}
                  {entry.metadata.pullRequest && (
                    <div style={{ marginTop: '0.5rem' }}>
                      Pull Request: <a 
                        href={entry.metadata.pullRequest.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#3b82f6', textDecoration: 'none' }}
                      >
                        #{entry.metadata.pullRequest.number}
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Prompt Modal */}
      {selectedPrompt && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            backgroundColor: '#ffffff',
            borderRadius: '8px',
            padding: '1.5rem',
            maxWidth: '80%',
            maxHeight: '80vh',
            overflow: 'auto',
            boxShadow: '0 10px 25px rgba(0, 0, 0, 0.1)'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem'
            }}>
              <h3 style={{ margin: 0 }}>LLM Prompt</h3>
              <button
                onClick={() => setSelectedPrompt(null)}
                style={{
                  padding: '0.5rem 1rem',
                  backgroundColor: '#6b7280',
                  color: '#ffffff',
                  borderRadius: '4px',
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                Close
              </button>
            </div>
            
            <div style={{
              marginBottom: '1rem',
              fontSize: '0.875rem',
              color: '#6b7280'
            }}>
              <div>Session ID: {selectedPrompt.sessionId}</div>
              {selectedPrompt.conversationId && <div>Conversation ID: {selectedPrompt.conversationId}</div>}
              <div>Model: {selectedPrompt.model}</div>
              <div>Timestamp: {selectedPrompt.timestamp}</div>
              {selectedPrompt.isRetry && (
                <div style={{ marginTop: '0.5rem', color: '#f59e0b' }}>
                  Retry: {selectedPrompt.retryReason || 'Yes'}
                </div>
              )}
            </div>
            
            <div style={{
              backgroundColor: '#f3f4f6',
              borderRadius: '4px',
              padding: '1rem',
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowX: 'auto'
            }}>
              {selectedPrompt.prompt}
            </div>
          </div>
        </div>
      )}

      {/* Log Files Modal */}
      {logFiles && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            backgroundColor: '#ffffff',
            borderRadius: '8px',
            padding: '1.5rem',
            maxWidth: '600px',
            width: '90%',
            maxHeight: '80vh',
            overflow: 'auto',
            boxShadow: '0 10px 25px rgba(0, 0, 0, 0.1)'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem'
            }}>
              <h3 style={{ margin: 0 }}>Log Files</h3>
              <button
                onClick={() => setLogFiles(null)}
                style={{
                  padding: '0.5rem 1rem',
                  backgroundColor: '#6b7280',
                  color: '#ffffff',
                  borderRadius: '4px',
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                Close
              </button>
            </div>
            
            {logFiles.files && Object.keys(logFiles.files).length > 0 ? (
              <div>
                <p style={{ marginBottom: '1rem', color: '#6b7280' }}>
                  Click on a log file to view its contents:
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {Object.entries(logFiles.files).map(([type, path]) => (
                    <button
                      key={type}
                      onClick={() => viewLogFile(
                        window._currentSessionInfo?.sessionId,
                        window._currentSessionInfo?.conversationId,
                        type
                      )}
                      style={{
                        padding: '0.75rem',
                        backgroundColor: '#f3f4f6',
                        border: '1px solid #e5e7eb',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'background-color 0.2s'
                      }}
                      onMouseEnter={(e) => e.target.style.backgroundColor = '#e5e7eb'}
                      onMouseLeave={(e) => e.target.style.backgroundColor = '#f3f4f6'}
                      disabled={loadingLogFile}
                    >
                      <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
                        {type === 'conversation' ? '💬 Conversation Log' : '📄 Raw Output'}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                        {path.split('/').pop()}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p style={{ color: '#6b7280', textAlign: 'center' }}>
                No log files available for this execution
              </p>
            )}
          </div>
        </div>
      )}

      {/* Log File Content Modal */}
      {selectedLogFile && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1001
        }}>
          <div style={{
            backgroundColor: '#ffffff',
            borderRadius: '8px',
            padding: '1.5rem',
            maxWidth: '90%',
            maxHeight: '90vh',
            overflow: 'auto',
            boxShadow: '0 10px 25px rgba(0, 0, 0, 0.1)'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem'
            }}>
              <h3 style={{ margin: 0 }}>
                {selectedLogFile.type === 'conversation' ? '💬 Conversation Log' : '📄 Raw Output'}
              </h3>
              <button
                onClick={() => setSelectedLogFile(null)}
                style={{
                  padding: '0.5rem 1rem',
                  backgroundColor: '#6b7280',
                  color: '#ffffff',
                  borderRadius: '4px',
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                Close
              </button>
            </div>
            
            <div style={{
              backgroundColor: '#f3f4f6',
              borderRadius: '4px',
              padding: '1rem',
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowX: 'auto',
              maxHeight: '70vh',
              overflowY: 'auto'
            }}>
              {selectedLogFile.isJson
                ? JSON.stringify(selectedLogFile.content, null, 2)
                : selectedLogFile.content}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskDetails;