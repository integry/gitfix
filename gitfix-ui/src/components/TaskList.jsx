import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getTasks } from '../api/gitfixApi';

const TaskList = ({ limit, showViewAll = false }) => {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    const fetchTasks = async (loadConfig) => {
      try {
        setLoading(loadConfig?.setLoadingState ?? true);
        const data = await getTasks(filter, limit);
        setTasks(data.tasks || []);
      } catch (err) {
        setError(err.message);
        console.error('Error fetching tasks:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchTasks({ setLoadingState: true });
    const interval = setInterval(() => fetchTasks({ setLoadingState: false }), 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, [filter, limit]);

  const getStatusColor = (status) => {
    switch (status) {
      case 'completed':
        return '#22c55e';
      case 'failed':
        return '#ef4444';
      case 'active':
        return '#3b82f6';
      case 'waiting':
        return '#a855f7';
      default:
        return '#6b7280';
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const formatDuration = (startTime, endTime, status) => {
    if (!startTime) return 'N/A';
    
    // For active tasks, calculate duration from start time to now
    const end = endTime ? new Date(endTime) : new Date();
    const duration = end - new Date(startTime);
    
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);
    
    // Add indicator for active tasks
    const suffix = status === 'active' ? ' (running)' : '';
    return `${minutes}m ${seconds}s${suffix}`;
  };

  if (loading && tasks.length === 0) return <div>Loading tasks...</div>;
  if (error) return <div>Error loading tasks: {error}</div>;

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
        <h3>Tasks</h3>
        <select 
          value={filter} 
          onChange={(e) => setFilter(e.target.value)}
          style={{
            padding: '0.5rem',
            borderRadius: '4px',
            border: '1px solid #d1d5db',
            backgroundColor: '#ffffff',
            cursor: 'pointer'
          }}
        >
          <option value="all">All Tasks</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="waiting">Waiting</option>
        </select>
        {showViewAll && (
          <Link to="/tasks" style={{ color: '#3b82f6', textDecoration: 'none' }}>
            View All Tasks
          </Link>
        )}
      </div>

      {tasks.length === 0 ? (
        <p style={{ color: '#6b7280', textAlign: 'center' }}>No tasks found</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <th style={{ padding: '0.75rem', textAlign: 'left' }}>Repository</th>
                <th style={{ padding: '0.75rem', textAlign: 'left' }}>Issue/Task</th>
                <th style={{ padding: '0.75rem', textAlign: 'left' }}>Status</th>
                <th style={{ padding: '0.75rem', textAlign: 'left' }}>Created</th>
                <th style={{ padding: '0.75rem', textAlign: 'left' }}>Duration</th>
                <th style={{ padding: '0.75rem', textAlign: 'left' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr 
                  key={task.id}
                  style={{ 
                    borderBottom: '1px solid #f3f4f6',
                    cursor: 'pointer',
                    ':hover': { backgroundColor: '#f9fafb' }
                  }}
                >
                  <td style={{ padding: '0.75rem' }}>
                    {task.repository || 'Unknown'}
                  </td>
                  <td style={{ padding: '0.75rem' }}>
                    <div style={{ fontWeight: '500' }}>
                      {task.id.startsWith('pr-comments-batch') ? 
                        `PR #${task.issueNumber || 'N/A'} Comments` : 
                        task.issueNumber ? `Issue #${task.issueNumber}` : 'Task'
                      }
                    </div>
                    {task.title && (
                      <div style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '0.25rem' }}>
                        {task.title.substring(0, 60)}
                        {task.title.length > 60 && '...'}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '0.75rem' }}>
                    <span style={{
                      color: getStatusColor(task.status),
                      fontWeight: '500',
                      textTransform: 'capitalize'
                    }}>
                      {task.status}
                    </span>
                  </td>
                  <td style={{ padding: '0.75rem', fontSize: '0.875rem' }}>
                    {formatDate(task.createdAt)}
                  </td>
                  <td style={{ padding: '0.75rem' }}>
                    {formatDuration(task.processedAt || task.createdAt, task.completedAt, task.status)}
                  </td>
                  <td style={{ padding: '0.75rem' }}>
                    <Link to={`/tasks/${task.id}`}>
                      <button
                        style={{
                          padding: '0.25rem 0.75rem',
                          backgroundColor: '#3b82f6',
                          color: '#ffffff',
                          borderRadius: '4px',
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: '0.875rem'
                        }}
                      >
                        View Details
                      </button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default TaskList;