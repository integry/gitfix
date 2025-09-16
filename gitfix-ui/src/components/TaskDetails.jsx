import { useState, useEffect } from 'react';
import { getTaskHistory } from '../api/gitfixApi';

const TaskDetails = ({ taskId, onBack }) => {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
    </div>
  );
};

export default TaskDetails;