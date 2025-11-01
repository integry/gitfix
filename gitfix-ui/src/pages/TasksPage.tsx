import React from 'react';
import { useParams } from 'react-router-dom';
import TaskList from '../components/TaskList';
import TaskDetails from '../components/TaskDetails';

const TasksPage: React.FC = () => {
  const { taskId } = useParams();

  return (
    <div>
      {taskId ? (
        <TaskDetails />
      ) : (
        <>
          <h2 className="text-brand-text-light text-2xl font-semibold mb-4">Tasks</h2>
          <p className="text-brand-text-dim mb-4">View all current and previous tasks.</p>
          <TaskList limit={50} />
        </>
      )}
    </div>
  );
};

export default TasksPage;