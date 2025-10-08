import React from 'react';
import { useParams } from 'react-router-dom';
import TaskList from '../components/TaskList';
import TaskDetails from '../components/TaskDetails';

const TasksPage = () => {
  const { taskId } = useParams();

  return (
    <div>
      {taskId ? (
        <TaskDetails />
      ) : (
        <>
          <h2 style={{ color: '#fff', fontSize: '1.5rem', marginBottom: '1rem' }}>Tasks</h2>
          <p style={{ color: '#9ca3af' }}>View all current and previous tasks.</p>
          <TaskList />
        </>
      )}
    </div>
  );
};

export default TasksPage;
