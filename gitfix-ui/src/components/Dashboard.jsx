import React from 'react';
import SystemStatus from './SystemStatus';
import TaskQueueStats from './TaskQueueStats';

const Dashboard = () => {
  return (
    <div>
      <h2>System Overview</h2>
      <div style={{ display: 'flex', justifyContent: 'space-around', gap: '2rem', flexWrap: 'wrap' }}>
        <SystemStatus />
        <TaskQueueStats />
      </div>
    </div>
  );
};

export default Dashboard;