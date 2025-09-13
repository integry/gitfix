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

app.get('/api/tasks', ensureAuthenticated, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    
    // Get all task state keys
    const pattern = 'worker:state:*';
    const keys = await redisClient.keys(pattern);
    
    // Get all task states
    const tasks = [];
    for (const key of keys.slice(0, limit)) {
      try {
        const stateJson = await redisClient.get(key);
        if (stateJson) {
          const state = JSON.parse(stateJson);
          tasks.push(state);
        }
      } catch (err) {
        console.error(`Error parsing task state for key ${key}:`, err);
      }
    }
    
    // Sort by updatedAt descending (most recent first)
    tasks.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    
    res.json({
      tasks: tasks.slice(0, limit),
      total: keys.length
    });
  } catch (error) {
    console.error('Error in /api/tasks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/task/:taskId/state', ensureAuthenticated, async (req, res) => {
  try {
    const { taskId } = req.params;
    
    // Get task state from WorkerStateManager key format
    const stateKey = `worker:state:${taskId}`;
    const stateJson = await redisClient.get(stateKey);
    
    if (!stateJson) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const state = JSON.parse(stateJson);
    res.json(state);
  } catch (error) {
    console.error('Error in /api/task/:taskId/state:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/task/:taskId/history', ensureAuthenticated, async (req, res) => {
  try {
    const { taskId } = req.params;
    
    // Get persisted task history (logs and diffs)
    const historyKey = `task:${taskId}:history`;
    const historyJson = await redisClient.get(historyKey);
    
    if (!historyJson) {
      // Return empty history if not found
      return res.json({
        taskId,
        completedAt: null,
        logs: '',
        finalDiff: '',
        claudeResult: null
      });
    }
    
    const history = JSON.parse(historyJson);
    res.json(history);
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
    
    // Create HTTP server and attach both Express and WebSocket
    const server = http.createServer(app);
    
    // Setup WebSocket server
    await setupWebSocket(server);
    
    server.listen(PORT, () => {
      console.log(`Dashboard API server running on port ${PORT}`);
      console.log(`WebSocket server available at ws://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();