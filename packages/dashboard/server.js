const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');
const { Queue } = require('bullmq');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { setupAuth, ensureAuthenticated } = require('./auth');

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
  
  const queueName = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';
  taskQueue = new Queue(queueName, {
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
      githubAuth: 'unknown',
      claudeAuth: 'unknown',
      timestamp: new Date().toISOString()
    };
    
    try {
      await redisClient.ping();
      status.redis = 'connected';
      
      const daemonHeartbeat = await redisClient.get('system:status:daemon');
      if (daemonHeartbeat && Date.now() - parseInt(daemonHeartbeat) < 120000) {
        status.daemon = 'running';
      } else {
        status.daemon = 'stopped';
      }
      
      const workerHeartbeat = await redisClient.get('system:status:worker');
      if (workerHeartbeat && Date.now() - parseInt(workerHeartbeat) < 120000) {
        status.worker = 'running';
      } else {
        status.worker = 'stopped';
      }
      
      // Check GitHub authentication - verify GitHub App is configured
      const githubAppConfigured = process.env.GH_APP_ID && 
                                 process.env.GH_PRIVATE_KEY_PATH && 
                                 process.env.GH_INSTALLATION_ID;
      status.githubAuth = githubAppConfigured ? 'connected' : 'disconnected';
      
      // Check Claude authentication - verify recent successful executions
      let claudeActive = false;
      try {
        // Check recent activity for successful Claude executions
        const recentActivity = await redisClient.lRange('system:activity:log', 0, 20);
        const oneHourAgo = Date.now() - (60 * 60 * 1000); // 1 hour
        
        for (const activityStr of recentActivity) {
          try {
            const activity = JSON.parse(activityStr);
            // Check if this is a recent successful issue processing (which uses Claude)
            if (activity.type === 'issue_processed' && 
                activity.status === 'success' &&
                activity.id && activity.id.includes('claude-') &&
                new Date(activity.timestamp).getTime() > oneHourAgo) {
              claudeActive = true;
              break;
            }
          } catch (e) {
            // Skip invalid entries
          }
        }
      } catch (err) {
        console.error('Error checking Claude status:', err);
      }
      status.claudeAuth = claudeActive ? 'connected' : 'disconnected';
      
    } catch (error) {
      status.redis = 'disconnected';
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
    
    const parsedActivities = activities.map((activity, index) => {
      try {
        const parsed = JSON.parse(activity);
        // Ensure the activity has the expected format
        return {
          id: parsed.id || `activity-${Date.now()}-${index}`,
          type: parsed.type || 'info',
          timestamp: parsed.timestamp || new Date().toISOString(),
          user: parsed.user,
          repository: parsed.repository,
          issueNumber: parsed.issueNumber,
          description: parsed.description || parsed.message || JSON.stringify(parsed),
          status: parsed.status || 'info'
        };
      } catch (e) {
        // If it's not JSON, treat it as a simple message
        return {
          id: `activity-${Date.now()}-${index}`,
          type: 'info',
          timestamp: new Date().toISOString(),
          description: activity.toString(),
          status: 'info'
        };
      }
    });
    
    // Return as array directly for the frontend
    res.json(parsedActivities);
  } catch (error) {
    console.error('Error in /api/activity:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/metrics', ensureAuthenticated, async (req, res) => {
  try {
    // Get basic metrics
    const jobsProcessed = parseInt(await redisClient.get('metrics:jobs:processed') || '0');
    const jobsFailed = parseInt(await redisClient.get('metrics:jobs:failed') || '0');
    const avgTimeStr = await redisClient.get('metrics:jobs:avgTime') || '0';
    const avgTime = parseFloat(avgTimeStr);
    
    // Calculate success rate
    const totalJobs = jobsProcessed + jobsFailed;
    const successRate = totalJobs > 0 ? jobsProcessed / totalJobs : 1;
    
    // Get active repositories count
    const activeRepos = await redisClient.sMembers('active:repositories');
    const activeRepositories = activeRepos.length;
    
    // Get daily stats for the last 7 days
    const dailyStats = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateKey = date.toISOString().split('T')[0];
      
      const processed = parseInt(await redisClient.get(`metrics:daily:${dateKey}:processed`) || '0');
      const failed = parseInt(await redisClient.get(`metrics:daily:${dateKey}:failed`) || '0');
      const successful = processed - failed;
      
      dailyStats.push({
        date: dateKey,
        processed,
        successful,
        failed
      });
    }
    
    const metrics = {
      totalIssuesProcessed: jobsProcessed,
      successRate,
      averageProcessingTime: avgTime,
      activeRepositories,
      dailyStats,
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

app.get('/api/task/:taskId/history', ensureAuthenticated, async (req, res) => {
  try {
    const { taskId } = req.params;
    
    const historyKey = `task:${taskId}:history`;
    const history = await redisClient.lRange(historyKey, 0, -1);
    
    const parsedHistory = history.map(entry => {
      try {
        return JSON.parse(entry);
      } catch (e) {
        return entry;
      }
    });
    
    res.json({
      taskId,
      history: parsedHistory
    });
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
    
    app.listen(PORT, () => {
      console.log(`Dashboard API server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();