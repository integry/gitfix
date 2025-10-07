const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');
const { Queue } = require('bullmq');
const path = require('path');
const fs = require('fs-extra');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { setupAuth, ensureAuthenticated } = require('./auth');
const { getLLMMetricsSummary, getLLMMetricsByCorrelationId } = require('./llmMetricsAdapter');

let generateCorrelationId;
let configRepoManager;

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
      issueNumber: job.data?.number || job.data?.issueNumber || 
        (job.id.startsWith('pr-comments-batch') ? 
          parseInt(job.id.match(/-(\d+)-\d+$/)?.[1]) : null),
      title: job.returnvalue?.issueTitle || job.data?.title || null,
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
  }
});

app.get('/api/llm-metrics', ensureAuthenticated, async (req, res) => {
  try {
    const llmMetrics = await getLLMMetricsSummary();
    res.json(llmMetrics);
  } catch (error) {
    console.error('Error in /api/llm-metrics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/llm-metrics/:correlationId', ensureAuthenticated, async (req, res) => {
  try {
    const { correlationId } = req.params;
    const metrics = await getLLMMetricsByCorrelationId(correlationId);
    
    if (!metrics) {
      return res.status(404).json({ error: 'Metrics not found for this correlation ID' });
    }
    
    res.json(metrics);
  } catch (error) {
    console.error('Error in /api/llm-metrics/:correlationId:', error);
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
                model: job.returnvalue.modelName,
                sessionId: claudeResult.sessionId,
                conversationId: claudeResult.conversationId
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
                  conversationTurns: claudeResult.conversationLog?.length || 0,
                  sessionId: claudeResult.sessionId,
                  conversationId: claudeResult.conversationId,
                  model: claudeResult.model
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

app.get('/api/execution/:sessionId/prompt', ensureAuthenticated, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Try to fetch prompt by sessionId first
    let promptData = null;
    const sessionKey = `execution:prompt:session:${sessionId}`;
    const promptJson = await redisClient.get(sessionKey);
    
    if (promptJson) {
      promptData = JSON.parse(promptJson);
    } else {
      // Fallback to conversationId if provided
      const { conversationId } = req.query;
      if (conversationId) {
        const conversationKey = `execution:prompt:conversation:${conversationId}`;
        const conversationPromptJson = await redisClient.get(conversationKey);
        if (conversationPromptJson) {
          promptData = JSON.parse(conversationPromptJson);
        }
      }
    }
    
    if (!promptData) {
      return res.status(404).json({ error: 'Prompt not found for this execution' });
    }
    
    res.json({
      sessionId,
      ...promptData
    });
  } catch (error) {
    console.error('Error in /api/execution/:sessionId/prompt:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get log files for a specific execution
app.get('/api/execution/:sessionId/logs', ensureAuthenticated, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Try to get log data from Redis
    let logData = null;
    const sessionKey = `execution:logs:session:${sessionId}`;
    const logJson = await redisClient.get(sessionKey);
    
    if (logJson) {
      logData = JSON.parse(logJson);
    } else {
      // Fallback to conversationId if provided
      const { conversationId } = req.query;
      if (conversationId) {
        const conversationKey = `execution:logs:conversation:${conversationId}`;
        const conversationLogJson = await redisClient.get(conversationKey);
        if (conversationLogJson) {
          logData = JSON.parse(conversationLogJson);
        }
      }
    }
    
    if (!logData || !logData.files) {
      return res.status(404).json({ error: 'Log files not found for this execution' });
    }
    
    res.json({
      sessionId,
      ...logData
    });
  } catch (error) {
    console.error('Error in /api/execution/:sessionId/logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve a specific log file
app.get('/api/execution/:sessionId/logs/:type', ensureAuthenticated, async (req, res) => {
  try {
    const { sessionId, type } = req.params;
    const fs = require('fs').promises;
    
    // Get log data from Redis
    let logData = null;
    const sessionKey = `execution:logs:session:${sessionId}`;
    const logJson = await redisClient.get(sessionKey);
    
    if (logJson) {
      logData = JSON.parse(logJson);
    } else {
      // Fallback to conversationId if provided
      const { conversationId } = req.query;
      if (conversationId) {
        const conversationKey = `execution:logs:conversation:${conversationId}`;
        const conversationLogJson = await redisClient.get(conversationKey);
        if (conversationLogJson) {
          logData = JSON.parse(conversationLogJson);
        }
      }
    }
    
    if (!logData || !logData.files || !logData.files[type]) {
      return res.status(404).json({ error: `Log file '${type}' not found for this execution` });
    }
    
    const filePath = logData.files[type];
    
    // Check if file exists
    try {
      await fs.access(filePath);
    } catch (err) {
      return res.status(404).json({ error: `Log file no longer exists at ${filePath}` });
    }
    
    // Read and return file content
    const content = await fs.readFile(filePath, 'utf8');
    
    // Set appropriate content type
    const contentType = type === 'conversation' ? 'application/json' : 'text/plain';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
    
    res.send(content);
  } catch (error) {
    console.error('Error in /api/execution/:sessionId/logs/:type:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/import-tasks', ensureAuthenticated, async (req, res) => {
  try {
    const { taskDescription, repository } = req.body;
    
    if (!taskDescription || !repository) {
      return res.status(400).json({ error: 'taskDescription and repository are required' });
    }
    
    const jobId = `import-tasks-${repository.replace('/', '-')}-${Date.now()}`;
    const correlationId = generateCorrelationId();
    
    const job = await taskQueue.add('processTaskImport', {
      taskDescription,
      repository,
      correlationId,
      user: req.user.username
    }, {
      jobId
    });
    
    res.json({ jobId: job.id });
  } catch (error) {
    console.error('Error in /api/import-tasks:', error);
    res.status(500).json({ error: 'Failed to create import task' });
  }
});

app.get('/api/config/repos', ensureAuthenticated, async (req, res) => {
  try {
    await configRepoManager.cloneOrPullConfigRepo();
    const configRepoPath = process.env.CONFIG_REPO_PATH || path.join(process.cwd(), '.config_repo');
    const configPath = path.join(configRepoPath, 'config.json');
    const config = await fs.readJson(configPath);
    let repos = config.repos_to_monitor || [];

    // Convert string array to object array if needed
    if (repos.length > 0 && typeof repos[0] === 'string') {
      repos = repos.map(repo => ({ name: repo, enabled: true }));
    }

    res.json({ repos_to_monitor: repos });
  } catch (error) {
    console.error('Error in /api/config/repos GET:', error);
    res.status(500).json({ error: 'Failed to load repository configuration' });
  }
});

app.post('/api/config/repos', ensureAuthenticated, async (req, res) => {
  const lockKey = 'config:repos:lock';
  const lockValue = `${Date.now()}-${Math.random()}`;
  const lockTimeout = 30;
  
  try {
    const { repos_to_monitor } = req.body;
    
    if (!Array.isArray(repos_to_monitor)) {
      return res.status(400).json({ error: 'repos_to_monitor must be an array' });
    }
    
    for (const repo of repos_to_monitor) {
      if (typeof repo.name !== 'string' || 
          !repo.name.match(/^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_]+$/) ||
          typeof repo.enabled !== 'boolean'
      ) {
        return res.status(400).json({ error: `Invalid repository format: ${JSON.stringify(repo)}` });
      }
    }
    
    const acquired = await redisClient.set(lockKey, lockValue, {
      NX: true,
      EX: lockTimeout
    });
    
    if (!acquired) {
      return res.status(409).json({ error: 'Configuration is being updated by another request. Please try again.' });
    }
    
    try {
      await configRepoManager.saveMonitoredRepos(
        repos_to_monitor,
        `Update monitored repositories via UI by ${req.user.username}`
      );
      
      const activity = {
        id: `activity-${Date.now()}-config-update`,
        type: 'config_updated',
        timestamp: new Date().toISOString(),
        user: req.user.username,
        description: `Updated monitored repositories list (${repos_to_monitor.length} repos)`,
        status: 'success'
      };
      await redisClient.lPush('system:activity:log', JSON.stringify(activity));
      await redisClient.lTrim('system:activity:log', 0, 999);
      
      res.json({ success: true, repos_to_monitor });
    } finally {
      const currentLockValue = await redisClient.get(lockKey);
      if (currentLockValue === lockValue) {
        await redisClient.del(lockKey);
      }
    }
  } catch (error) {
    console.error('Error in /api/config/repos POST:', error);
    
    try {
      const currentLockValue = await redisClient.get(lockKey);
      if (currentLockValue === lockValue) {
        await redisClient.del(lockKey);
      }
    } catch (unlockError) {
      console.error('Error releasing lock:', unlockError);
    }
    
    res.status(500).json({ error: 'Failed to update repository configuration' });
  }
});

app.get('/api/github/repos', ensureAuthenticated, async (req, res) => {
  try {
    if (!req.user.accessToken) {
      return res.status(401).json({ error: 'GitHub access token not available' });
    }

    const fetch = (await import('node-fetch')).default;
    const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
      headers: {
        'Authorization': `Bearer ${req.user.accessToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'GitFix-Dashboard'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API request failed: ${response.status}`);
    }

    const repos = await response.json();
    const repoNames = repos.map(repo => repo.full_name);

    res.json({ repos: repoNames });
  } catch (error) {
    console.error('Error in /api/github/repos:', error);
    res.status(500).json({ error: 'Failed to fetch GitHub repositories' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/import-tasks', ensureAuthenticated, async (req, res) => {
  try {
    const { taskDescription, repository } = req.body;
    
    // Validate input
    if (!taskDescription || !repository) {
      return res.status(400).json({ 
        error: 'Both taskDescription and repository are required' 
      });
    }
    
    // Validate repository format
    const repoPattern = /^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_]+$/;
    if (!repoPattern.test(repository)) {
      return res.status(400).json({ 
        error: 'Invalid repository format. Expected: owner/name' 
      });
    }
    
    // Generate a unique job ID
    const jobId = `import-tasks-${repository.replace('/', '-')}-${Date.now()}`;
    
    // Create correlation ID for tracking
    const correlationId = `${jobId}-${Math.random().toString(36).substring(2, 9)}`;
    
    // Add job to queue
    const newJob = await taskQueue.add('processTaskImport', {
      taskDescription,
      repository,
      correlationId,
      user: req.user.username
    }, {
      jobId,
      removeOnComplete: {
        age: 24 * 3600, // Keep for 24 hours
        count: 100,     // Keep max 100 completed jobs
      },
      removeOnFail: {
        age: 7 * 24 * 3600, // Keep failed jobs for 7 days
      },
    });
    
    // Log activity
    const activity = {
      id: `activity-${Date.now()}-${jobId}`,
      type: 'task_import',
      timestamp: new Date().toISOString(),
      user: req.user.username,
      repository: repository,
      description: `Task import job created for ${repository}`,
      status: 'pending'
    };
    
    await redisClient.lpush('system:activity:log', JSON.stringify(activity));
    await redisClient.ltrim('system:activity:log', 0, 999); // Keep last 1000 activities
    
    console.log(`Created task import job ${jobId} for repository ${repository}`);
    
    res.json({ jobId: newJob.id });
  } catch (error) {
    console.error('Error in /api/import-tasks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function start() {
  try {
    // Dynamically import ES module
    const loggerModule = await import('../../src/utils/logger.js');
    generateCorrelationId = loggerModule.generateCorrelationId;

    configRepoManager = await import('../../src/config/configRepoManager.js');

    await initRedis();

    // Initialize config repository with config.json if it doesn't exist
    try {
      await configRepoManager.ensureConfigRepoExists();
    } catch (error) {
      console.warn('Failed to initialize config repository:', error.message);
    }

    app.listen(PORT, () => {
      console.log(`Dashboard API server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();