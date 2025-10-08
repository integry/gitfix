import React from 'react';
import SystemStatus from './SystemStatus';
import TaskQueueStats from './TaskQueueStats';
import TaskList from './TaskList';

const Dashboard = () => {
  return (
    <div>
      <h2>System Overview</h2>
      <div className="dashboard-grid">
        <SystemStatus />
        <TaskQueueStats />
      </div>
      
      <div style={{ marginTop: '2rem' }}>
        <h3>Recent Tasks</h3>
        <TaskList
          limit={5}
          showViewAll={true}
        />
      </div>
    </div>
  );
};

export default Dashboard;