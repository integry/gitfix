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
          <h2 className="text-white text-2xl font-semibold mb-4">Tasks</h2>
          <p className="text-gray-400 mb-4">View all current and previous tasks.</p>
          <TaskList />
        </>
      )}
    </div>
  );
};

export default TasksPage;