// Configuration for the dashboard client
// These values can be overridden by environment variables at build time

export const config = {
  API_BASE_URL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000',
  APP_URL: import.meta.env.VITE_APP_URL || 'http://localhost:5173',
};

export default config;