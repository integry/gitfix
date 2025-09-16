// API for fetching system data from backend

const API_BASE_URL = 'https://api.gitfix.dev';

export const getSystemStatus = async () => {
  const response = await fetch(`${API_BASE_URL}/api/status`);
  if (!response.ok) throw new Error('Failed to fetch system status');
  const data = await response.json();
  
  // Transform backend response to match frontend expectations
  return {
    daemon: data.daemon?.status === 'online' ? 'Running' : 'Stopped',
    workers: data.workers || [],
    redis: data.redis?.status === 'ready' ? 'Connected' : 'Disconnected',
    githubAuth: data.github?.authenticated ? 'Authenticated' : 'Failed',
  };
};

export const getQueueStats = async () => {
  const response = await fetch(`${API_BASE_URL}/api/queue/stats`);
  if (!response.ok) throw new Error('Failed to fetch queue stats');
  return response.json();
};
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