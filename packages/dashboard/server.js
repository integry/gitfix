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

app.get('/api/tasks', ensureAuthenticated, async (req, res) => {
  try {
    const { status = 'all', limit = 50, offset = 0 } = req.query;
    
    // Get jobs from the queue
    let jobs = [];
    if (status === 'all' || status === 'completed') {
      const completed = await taskQueue.getJobs(['completed'], parseInt(offset), parseInt(offset) + parseInt(limit));
      jobs = jobs.concat(completed);
    }
    if (status === 'all' || status === 'failed') {
      const failed = await taskQueue.getJobs(['failed'], parseInt(offset), parseInt(offset) + parseInt(limit));
      jobs = jobs.concat(failed);
    }
    if (status === 'all' || status === 'active') {
      const active = await taskQueue.getJobs(['active'], parseInt(offset), parseInt(offset) + parseInt(limit));
      jobs = jobs.concat(active);
    }
    if (status === 'all' || status === 'waiting') {
      const waiting = await taskQueue.getJobs(['waiting'], parseInt(offset), parseInt(offset) + parseInt(limit));
      jobs = jobs.concat(waiting);
    }
    
    // Transform jobs to task format
    const tasks = jobs.map(job => ({
      id: job.id,
      issueId: job.id, // Using job id as issueId for now
      repository: job.data?.repoOwner && job.data?.repoName 
        ? `${job.data.repoOwner}/${job.data.repoName}`
        : 'Unknown',
      issueNumber: job.data?.number || job.data?.issueNumber,
      title: job.data?.title || `Issue #${job.data?.number || 'N/A'}`,
      status: job.failedReason ? 'failed' : job.finishedOn ? 'completed' : job.processedOn ? 'active' : 'waiting',
      createdAt: new Date(job.timestamp).toISOString(),
      completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      failedReason: job.failedReason,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      modelName: job.data?.modelName
    }));
    
    // Sort by creation time descending
    tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({
      tasks: tasks.slice(0, limit),
      total: tasks.length,
      offset: parseInt(offset),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Error in /api/tasks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/task/:taskId/history', ensureAuthenticated, async (req, res) => {
  try {
    const { taskId } = req.params;
    
    // First try to get history from worker state
    const stateKey = `worker:state:${taskId}`;
    const stateData = await redisClient.get(stateKey);
    
    let history = [];
    if (stateData) {
      try {
        const state = JSON.parse(stateData);
        history = state.history || [];
      } catch (e) {
        console.error('Error parsing state data:', e);
      }
    }
    
    // If no history in state, try to reconstruct from job data
    if (history.length === 0 && taskQueue) {
      try {
        const job = await taskQueue.getJob(taskId);
        if (job) {
          // Create history from job lifecycle
          history = [];
          
          // Job created
          history.push({
            state: 'PENDING',
            timestamp: new Date(job.timestamp).toISOString(),
            message: 'Task created and queued'
          });
          
          // Job started
          if (job.processedOn) {
            history.push({
              state: 'PROCESSING',
              timestamp: new Date(job.processedOn).toISOString(),
              message: 'Task processing started'
            });
          }
          
          // Claude execution (if available in return value)
          if (job.returnvalue?.claudeResult) {
            const claudeResult = job.returnvalue.claudeResult;
            const claudeStartTime = job.processedOn ? new Date(job.processedOn).getTime() : job.timestamp;
            
            history.push({
              state: 'CLAUDE_EXECUTION',
              timestamp: new Date(claudeStartTime + 1000).toISOString(), // 1 second after start
              message: `Claude AI processing started with model: ${job.returnvalue.modelName || 'claude'}`,
              metadata: {
                model: job.returnvalue.modelName
              }
            });
            
            // Add Claude completion
            if (claudeResult.executionTime) {
              const claudeEndTime = claudeStartTime + claudeResult.executionTime;
              history.push({
                state: 'CLAUDE_COMPLETED',
                timestamp: new Date(claudeEndTime).toISOString(),
                message: claudeResult.success ? 'Claude execution completed successfully' : 'Claude execution failed',
                metadata: {
                  duration: claudeResult.executionTime,
                  success: claudeResult.success,
                  conversationTurns: claudeResult.conversationLog?.length || 0
                }
              });
            }
          }
          
          // Post-processing (if PR was created)
          if (job.returnvalue?.postProcessing) {
            const pp = job.returnvalue.postProcessing;
            history.push({
              state: 'POST_PROCESSING',
              timestamp: new Date(job.finishedOn - 5000).toISOString(), // 5 seconds before completion
              message: pp.success ? 'Creating pull request' : 'Post-processing failed',
              metadata: pp.pr ? {
                pullRequest: {
                  number: pp.pr.number,
                  url: pp.pr.url
                }
              } : undefined
            });
          }
          
          // Job completed or failed
          if (job.finishedOn) {
            history.push({
              state: job.failedReason ? 'FAILED' : 'COMPLETED',
              timestamp: new Date(job.finishedOn).toISOString(),
              message: job.failedReason || 
                      (job.returnvalue?.postProcessing?.pr ? 
                        `Task completed successfully. PR #${job.returnvalue.postProcessing.pr.number} created` : 
                        'Task completed successfully'),
              metadata: job.failedReason ? { error: job.failedReason } : undefined
            });
          }
        }
      } catch (e) {
        console.error('Error getting job data:', e);
      }
    }
    
    res.json({
      taskId,
      history
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