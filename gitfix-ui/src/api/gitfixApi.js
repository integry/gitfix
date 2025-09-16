// API for fetching system data from backend

const API_BASE_URL = 'https://api.gitfix.dev';

// Helper function to handle API responses and auth
const handleApiResponse = async (response) => {
  if (response.status === 401) {
    // Redirect to GitHub OAuth login
    window.location.href = `${API_BASE_URL}/api/auth/github`;
    throw new Error('Authentication required');
  }
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }
  return response;
};

export const getSystemStatus = async () => {
  const response = await fetch(`${API_BASE_URL}/api/status`, {
    credentials: 'include' // Include cookies for session
  });
  await handleApiResponse(response);
  const data = await response.json();
  
  // Transform backend response to match frontend expectations
  // The system has a single worker process, not multiple workers
  // Show worker status as a single item to be accurate
  let workers = [];
  if (data.worker === 'running') {
    workers = [
      { id: 1, status: 'active' }
    ];
  }
  
  return {
    daemon: data.daemon === 'running' ? 'Running' : 'Stopped',
    workers: workers,
    redis: data.redis === 'connected' ? 'Connected' : 'Disconnected',
    githubAuth: data.githubAuth === 'connected' ? 'Authenticated' : 'Failed',
    claudeAuth: data.claudeAuth === 'connected' ? 'Authenticated' : 'Failed',
  };
};

export const getQueueStats = async () => {
  const response = await fetch(`${API_BASE_URL}/api/queue/stats`, {
    credentials: 'include' // Include cookies for session
  });
  await handleApiResponse(response);
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