const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');
const { Queue } = require('bullmq');
const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { setupAuth, ensureAuthenticated } = require('./auth');
const { setupWebSocket } = require('./webSocket');

const app = express();
const PORT = process.env.DASHBOARD_API_PORT || 4000;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());

// Setup authentication
setupAuth(app);

let redisClient;
let taskQueue;

async function initRedis() {
  redisClient = createClient({
    url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`
  });
  
  redisClient.on('error', (err) => console.error('Redis Client Error', err));
  await redisClient.connect();
  
  taskQueue = new Queue('taskQueue', {
    connection: {
      host: process.env.REDIS_HOST || 'redis',
      port: process.env.REDIS_PORT || 6379
    }
  });
  
  console.log('Connected to Redis');
}

app.get('/api/status', ensureAuthenticated, async (req, res) => {
  try {
    const status = {
      api: 'healthy',
      redis: 'unknown',
      daemon: 'unknown',
      worker: 'unknown',
      timestamp: new Date().toISOString()
    };
    
    try {
      await redisClient.ping();
      status.redis = 'healthy';
      
      const daemonHeartbeat = await redisClient.get('system:status:daemon');
      if (daemonHeartbeat && Date.now() - parseInt(daemonHeartbeat) < 120000) {
        status.daemon = 'healthy';
      } else {
        status.daemon = 'unhealthy';
      }
      
      const workerHeartbeat = await redisClient.get('system:status:worker');
      if (workerHeartbeat && Date.now() - parseInt(workerHeartbeat) < 120000) {
        status.worker = 'healthy';
      } else {
        status.worker = 'unhealthy';
      }
    } catch (error) {
      status.redis = 'unhealthy';
    }
    
    res.json(status);
  } catch (error) {
    console.error('Error in /api/status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/queue/stats', ensureAuthenticated, async (req, res) => {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      taskQueue.getWaitingCount(),
      taskQueue.getActiveCount(),
      taskQueue.getCompletedCount(),
      taskQueue.getFailedCount(),
      taskQueue.getDelayedCount()
    ]);
    
    res.json({
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + completed + failed + delayed
    });
  } catch (error) {
    console.error('Error in /api/queue/stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/activity', ensureAuthenticated, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    const activities = await redisClient.lRange('system:activity:log', offset, offset + limit - 1);
    
    const parsedActivities = activities.map(activity => {
      try {
        return JSON.parse(activity);
      } catch (e) {
        return activity;
      }
    });
    
    res.json({
      activities: parsedActivities,
      total: await redisClient.lLen('system:activity:log'),
      limit,
      offset
    });
  } catch (error) {
    console.error('Error in /api/activity:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/metrics', ensureAuthenticated, async (req, res) => {
  try {
    const metrics = {
      jobsProcessed: await redisClient.get('metrics:jobs:processed') || '0',
      jobsFailed: await redisClient.get('metrics:jobs:failed') || '0',
      averageProcessingTime: await redisClient.get('metrics:jobs:avgTime') || '0',
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: new Date().toISOString()
    };
    
    res.json(metrics);
  } catch (error) {
    console.error('Error in /api/metrics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/task/:taskId', ensureAuthenticated, async (req, res) => {
  try {
    const { taskId } = req.params;
    
    const workerStateKey = `worker:${process.env.WORKER_ID || 'worker-1'}:state`;
    const workerState = await redisClient.get(workerStateKey);
    
    if (!workerState) {
      return res.status(404).json({ error: 'Worker state not found' });
    }
    
    const state = JSON.parse(workerState);
    const task = state.currentTasks?.find(t => t.id === taskId) || 
                 state.completedTasks?.find(t => t.id === taskId);
    
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const taskData = await redisClient.get(`task:${taskId}:data`);
    const taskHistory = await redisClient.get(`task:${taskId}:history`);
    
    res.json({
      task,
      data: taskData ? JSON.parse(taskData) : null,
      history: taskHistory ? JSON.parse(taskHistory) : null
    });
  } catch (error) {
    console.error('Error in /api/task/:taskId:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/task/:taskId/history', ensureAuthenticated, async (req, res) => {
  try {
    const { taskId } = req.params;
    
    // Get persisted task data
    const [taskData, taskOutput, taskDiff] = await Promise.all([
      redisClient.get(`task:${taskId}:data`),
      redisClient.get(`task:${taskId}:output`),
      redisClient.get(`task:${taskId}:diff`)
    ]);
    
    const response = {
      taskId,
      data: taskData ? JSON.parse(taskData) : null,
      output: taskOutput,
      diff: taskDiff
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error in /api/task/:taskId/history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function start() {
  try {
    await initRedis();
    
    const server = http.createServer(app);
    
    setupWebSocket(server);
    
    server.listen(PORT, () => {
      console.log(`Dashboard API server running on port ${PORT}`);
      console.log(`WebSocket server available at ws://localhost:${PORT}/ws/tasks/:taskId`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();