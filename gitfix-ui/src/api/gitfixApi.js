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

export const getTasks = async (status = 'all', limit = 50, offset = 0) => {
  const response = await fetch(`${API_BASE_URL}/api/tasks?status=${status}&limit=${limit}&offset=${offset}`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getTaskHistory = async (taskId) => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/history`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getRepoConfig = async () => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updateRepoConfig = async (repos) => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repos_to_monitor: repos }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getAvailableGithubRepos = async () => {
  const response = await fetch(`${API_BASE_URL}/api/github/repos`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};