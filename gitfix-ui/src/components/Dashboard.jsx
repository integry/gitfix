import React, { useState } from 'react';
import SystemStatus from './SystemStatus';
import TaskQueueStats from './TaskQueueStats';
import TaskList from './TaskList';
import TaskDetails from './TaskDetails';

const Dashboard = () => {
  const [selectedTaskId, setSelectedTaskId] = useState(null);

  return (
    <div>
      <h2>System Overview</h2>
      <div style={{ display: 'flex', justifyContent: 'space-around', gap: '2rem', flexWrap: 'wrap' }}>
        <SystemStatus />
        <TaskQueueStats />
      </div>
      
      {selectedTaskId ? (
        <TaskDetails 
          taskId={selectedTaskId} 
          onBack={() => setSelectedTaskId(null)} 
        />
      ) : (
        <TaskList 
          onTaskSelect={setSelectedTaskId} 
        />
      )}
    </div>
  );
};

export default Dashboard;