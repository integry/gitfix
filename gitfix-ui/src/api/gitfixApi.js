// Mock API for fetching system data
// In production, these would be actual fetch calls to the backend

export const getSystemStatus = async () => {
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 300));
  
  // In a real app, this would be a fetch call to the backend
  // For now, return mock data with some randomization to simulate real-time changes
  return {
    daemon: Math.random() > 0.1 ? 'Running' : 'Stopped',
    workers: [
      { id: 1, status: Math.random() > 0.3 ? 'active' : 'idle' },
      { id: 2, status: Math.random() > 0.5 ? 'active' : 'idle' },
      { id: 3, status: Math.random() > 0.7 ? 'active' : 'idle' }
    ],
    redis: Math.random() > 0.05 ? 'Connected' : 'Disconnected',
    githubAuth: Math.random() > 0.05 ? 'Authenticated' : 'Failed',
  };
};

export const getQueueStats = async () => {
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 300));
  
  // Return mock data with some variation
  return {
    active: Math.floor(Math.random() * 10),
    waiting: Math.floor(Math.random() * 50),
    completed: Math.floor(Math.random() * 200) + 100,
    failed: Math.floor(Math.random() * 5),
  };
};

// Future API endpoints to implement when backend is ready:
// 
// export const getSystemStatus = async () => {
//   const response = await fetch('/api/system/status');
//   if (!response.ok) throw new Error('Failed to fetch system status');
//   return response.json();
// };
//
// export const getQueueStats = async () => {
//   const response = await fetch('/api/queue/stats');
//   if (!response.ok) throw new Error('Failed to fetch queue stats');
//   return response.json();
// };
//
// export const getWorkerDetails = async (workerId) => {
//   const response = await fetch(`/api/workers/${workerId}`);
//   if (!response.ok) throw new Error('Failed to fetch worker details');
//   return response.json();
// };
//
// export const getActivityFeed = async (limit = 10) => {
//   const response = await fetch(`/api/activity?limit=${limit}`);
//   if (!response.ok) throw new Error('Failed to fetch activity feed');
//   return response.json();
// };
//
// export const getConfiguration = async () => {
//   const response = await fetch('/api/config');
//   if (!response.ok) throw new Error('Failed to fetch configuration');
//   return response.json();
// };
//
// export const updateConfiguration = async (config) => {
//   const response = await fetch('/api/config', {
//     method: 'PUT',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify(config)
//   });
//   if (!response.ok) throw new Error('Failed to update configuration');
//   return response.json();
// };