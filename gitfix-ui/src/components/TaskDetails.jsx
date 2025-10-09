import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getTaskHistory, getTaskLiveDetails } from '../api/gitfixApi';

const TaskDetails = () => {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedPrompt, setSelectedPrompt] = useState(null);
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [logFiles, setLogFiles] = useState(null);
  const [selectedLogFile, setSelectedLogFile] = useState(null);
  const [loadingLogFile, setLoadingLogFile] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const logContentRef = useRef(null);
  const [liveDetails, setLiveDetails] = useState({ todos: [], currentTask: null });

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

  useEffect(() => {
    const isTaskActive = history.length > 0 && 
      ['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(
        history[history.length - 1]?.state?.toUpperCase()
      );

    if (isTaskActive) {
      const fetchLiveDetails = async () => {
        try {
          const data = await getTaskLiveDetails(taskId);
          setLiveDetails(data);
        } catch (err) {
          console.error('Error fetching live task details:', err);
        }
      };

      fetchLiveDetails();
      const interval = setInterval(fetchLiveDetails, 2000);
      return () => clearInterval(interval);
    }
  }, [taskId, history]);

  useEffect(() => {
    if (selectedLogFile && searchQuery) {
      const content = selectedLogFile.isJson
        ? JSON.stringify(selectedLogFile.content, null, 2)
        : selectedLogFile.content;
      const regex = new RegExp(searchQuery, 'gi');
      const matches = [...content.matchAll(regex)];
      setSearchMatches(matches);
      setCurrentMatchIndex(0);
    } else {
      setSearchMatches([]);
    }
  }, [searchQuery, selectedLogFile]);

  const handleSearchChange = (e) => {
    setSearchQuery(e.target.value);
  };

  useEffect(() => {
    if (searchMatches.length > 0 && logContentRef.current) {
      const marks = logContentRef.current.querySelectorAll('mark');
      if (marks[currentMatchIndex]) {
        marks.forEach((mark, index) => {
          if (index === currentMatchIndex) {
            mark.style.backgroundColor = '#fbbf24';
            mark.style.fontWeight = 'bold';
            mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } else {
            mark.style.backgroundColor = '#fef3c7';
            mark.style.fontWeight = 'normal';
          }
        });
      }
    }
  }, [currentMatchIndex, searchMatches]);

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

  const downloadLogFile = () => {
    if (!selectedLogFile) return;
    const content = selectedLogFile.isJson
      ? JSON.stringify(selectedLogFile.content, null, 2)
      : selectedLogFile.content;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${taskId}-${selectedLogFile.type}.log`;
    a.click();
    URL.revokeObjectURL(url);
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
        <h3 style={{ wordBreak: 'break-all' }}>Task History: {taskId}</h3>
        <button
          onClick={() => navigate('/tasks')}
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

      {liveDetails.todos.length > 0 && (
        <div style={{ 
          marginBottom: '1.5rem', 
          padding: '1rem', 
          backgroundColor: '#f0f9ff', 
          borderRadius: '8px',
          border: '2px solid #3b82f6'
        }}>
          <h4 style={{ marginTop: 0, color: '#1e40af', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.2rem' }}>⚡</span>
            Live Task Progress
          </h4>
          {liveDetails.currentTask && (
            <p style={{ 
              marginBottom: '1rem', 
              padding: '0.75rem', 
              backgroundColor: '#dbeafe', 
              borderRadius: '6px',
              borderLeft: '4px solid #3b82f6'
            }}>
              <strong style={{ color: '#1e40af' }}>Current Task:</strong> {liveDetails.currentTask}
            </p>
          )}
          <h5 style={{ marginTop: '1rem', marginBottom: '0.5rem', color: '#1e40af' }}>To-do List:</h5>
          <ul style={{ listStyleType: 'none', paddingLeft: 0, margin: 0 }}>
            {liveDetails.todos.map(todo => (
              <li key={todo.id} style={{ 
                display: 'flex', 
                alignItems: 'center', 
                marginBottom: '0.5rem',
                padding: '0.5rem',
                backgroundColor: todo.status === 'in_progress' ? '#dbeafe' : 'transparent',
                borderRadius: '4px',
                transition: 'background-color 0.2s'
              }}>
                <span style={{ marginRight: '0.5rem', fontSize: '1.1rem' }}>
                  {todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '⏳' : '📋'}
                </span>
                <span style={{ 
                  textDecoration: todo.status === 'completed' ? 'line-through' : 'none',
                  color: todo.status === 'completed' ? '#6b7280' : '#374151',
                  fontWeight: todo.status === 'in_progress' ? 'bold' : 'normal'
                }}>
                  {todo.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

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
              flexDirection: 'column',
              gap: '1rem',
              marginBottom: '1rem'
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <h3 style={{ margin: 0 }}>
                  {selectedLogFile.type === 'conversation' ? '💬 Conversation Log' : '📄 Raw Output'}
                </h3>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    onClick={downloadLogFile}
                    style={{
                      padding: '0.5rem 1rem',
                      backgroundColor: '#10b981',
                      color: '#ffffff',
                      borderRadius: '4px',
                      border: 'none',
                      cursor: 'pointer'
                    }}
                  >
                    Download
                  </button>
                  <button
                    onClick={() => {
                      setSelectedLogFile(null);
                      setSearchQuery('');
                      setSearchMatches([]);
                      setCurrentMatchIndex(0);
                    }}
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
              </div>
              
              <div style={{ 
                display: 'flex', 
                alignItems: 'center',
                gap: '0.5rem',
                backgroundColor: '#f3f4f6',
                borderRadius: '4px',
                padding: '0.5rem'
              }}>
                <input
                  type="text"
                  placeholder="Search log..."
                  value={searchQuery}
                  onChange={handleSearchChange}
                  style={{
                    flex: 1,
                    padding: '0.5rem',
                    border: '1px solid #e5e7eb',
                    borderRadius: '4px',
                    fontSize: '0.875rem'
                  }}
                />
                <button 
                  onClick={() => setCurrentMatchIndex(Math.max(0, currentMatchIndex - 1))} 
                  disabled={searchMatches.length === 0}
                  style={{
                    padding: '0.5rem 0.75rem',
                    backgroundColor: searchMatches.length > 0 ? '#3b82f6' : '#9ca3af',
                    color: '#ffffff',
                    borderRadius: '4px',
                    border: 'none',
                    cursor: searchMatches.length > 0 ? 'pointer' : 'not-allowed',
                    fontSize: '0.875rem'
                  }}
                >
                  &lt;
                </button>
                <span style={{ 
                  fontSize: '0.875rem', 
                  color: '#6b7280',
                  minWidth: '60px',
                  textAlign: 'center'
                }}>
                  {searchMatches.length > 0 ? `${currentMatchIndex + 1} of ${searchMatches.length}` : '0 of 0'}
                </span>
                <button 
                  onClick={() => setCurrentMatchIndex(Math.min(searchMatches.length - 1, currentMatchIndex + 1))} 
                  disabled={searchMatches.length === 0}
                  style={{
                    padding: '0.5rem 0.75rem',
                    backgroundColor: searchMatches.length > 0 ? '#3b82f6' : '#9ca3af',
                    color: '#ffffff',
                    borderRadius: '4px',
                    border: 'none',
                    cursor: searchMatches.length > 0 ? 'pointer' : 'not-allowed',
                    fontSize: '0.875rem'
                  }}
                >
                  &gt;
                </button>
              </div>
            </div>
            
            <div 
              ref={logContentRef}
              style={{
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
              }}
            >
              {searchQuery ? (
                <div dangerouslySetInnerHTML={{
                  __html: (selectedLogFile.isJson
                    ? JSON.stringify(selectedLogFile.content, null, 2)
                    : selectedLogFile.content
                  ).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (match) => `<mark style="background-color: #fef3c7; padding: 0 2px; border-radius: 2px;">${match}</mark>`)
                }} />
              ) : (
                selectedLogFile.isJson
                  ? JSON.stringify(selectedLogFile.content, null, 2)
                  : selectedLogFile.content
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskDetails;