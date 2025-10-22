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
      status.daemon = (daemonHeartbeat && Date.now() - parseInt(daemonHeartbeat) < 120000) ? 'running' : 'stopped';
      
      const activeWorkers = await redisClient.sCard('system:status:workers');
      status.worker = activeWorkers > 0 ? 'running' : 'stopped';
      status.workerCount = activeWorkers;
      
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
    let taskInfo = null;
    if (stateData) {
      try {
        const state = JSON.parse(stateData);
        history = (state.history || []).map(item => {
          const enrichedItem = { ...item };
          if (item.metadata?.sessionId) {
            enrichedItem.promptPath = `/api/execution/${item.metadata.sessionId}/prompt`;
            enrichedItem.logsPath = `/api/execution/${item.metadata.sessionId}/logs`;
          }
          return enrichedItem;
        });
        
        // Extract task info from state
        if (state.issueRef) {
          taskInfo = {
            repoOwner: state.issueRef.repoOwner,
            repoName: state.issueRef.repoName,
            number: state.issueRef.number,
            type: taskId.startsWith('pr-comments-batch-') ? 'pr-comment' : 'issue',
            comments: state.issueRef.comments
          };
        }
      } catch (e) {
        console.error('Error parsing state data:', e);
      }
    }
    
    // If no history in state, try to reconstruct from job data
    if (history.length === 0 && taskQueue) {
      try {
        const job = await taskQueue.getJob(taskId);
        if (job) {
          // Extract task info from job data if not already set
          if (!taskInfo && job.data) {
            if (job.data.repoOwner && job.data.repoName) {
              taskInfo = {
                repoOwner: job.data.repoOwner,
                repoName: job.data.repoName,
                number: job.data.pullRequestNumber || job.data.number,
                type: taskId.startsWith('pr-comments-batch-') ? 'pr-comment' : 'issue',
                comments: job.data.comments
              };
            }
          }
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
              promptPath: `/api/execution/${claudeResult.sessionId}/prompt`,
              logsPath: `/api/execution/${claudeResult.sessionId}/logs`,
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
                promptPath: `/api/execution/${claudeResult.sessionId}/prompt`,
                logsPath: `/api/execution/${claudeResult.sessionId}/logs`,
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
      history,
      taskInfo
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

app.get('/api/task/:taskId/docker-info', ensureAuthenticated, async (req, res) => {
  try {
    const { taskId: jobId } = req.params;

    // Compute the actual worker state taskId from the jobId
    let taskId = jobId;
    if (jobId.startsWith('issue-')) {
      const parts = jobId.replace(/^issue-/, '').split('-');
      parts.pop();
      taskId = parts.join('-');
    }

    const stateKey = `worker:state:${taskId}`;
    const stateData = await redisClient.get(stateKey);

    if (!stateData) {
      return res.status(404).json({ error: 'Task state not found' });
    }

    const state = JSON.parse(stateData);
    const claudeExecutionEntry = state.history.find(h => h.state === 'claude_execution' && h.metadata?.containerId);

    if (!claudeExecutionEntry || !claudeExecutionEntry.metadata?.containerId) {
      return res.status(404).json({ error: 'No Docker container info available for this task' });
    }

    const { containerId, containerName } = claudeExecutionEntry.metadata;

    // Check if container is still running
    const { execSync } = require('child_process');
    let containerStatus = 'unknown';
    let containerInfo = null;

    try {
      const statusOutput = execSync(
        `docker ps -a --filter "id=${containerId}" --format "{{.Status}}"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      
      if (statusOutput) {
        containerStatus = statusOutput.includes('Up') ? 'running' : 'stopped';
        containerInfo = {
          id: containerId,
          name: containerName,
          status: containerStatus,
          logsAvailable: true
        };
      } else {
        containerInfo = {
          id: containerId,
          name: containerName,
          status: 'removed',
          logsAvailable: false
        };
      }
    } catch (err) {
      console.error('Error checking container status:', err);
      containerInfo = {
        id: containerId,
        name: containerName,
        status: 'error',
        logsAvailable: false,
        error: err.message
      };
    }

    res.json(containerInfo);
  } catch (error) {
    console.error('Error in /api/task/:taskId/docker-info:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/task/:taskId/docker-logs', ensureAuthenticated, async (req, res) => {
  try {
    const { taskId: jobId } = req.params;
    const { tail = '100', follow = 'false' } = req.query;

    // Compute the actual worker state taskId from the jobId
    let taskId = jobId;
    if (jobId.startsWith('issue-')) {
      const parts = jobId.replace(/^issue-/, '').split('-');
      parts.pop();
      taskId = parts.join('-');
    }

    const stateKey = `worker:state:${taskId}`;
    const stateData = await redisClient.get(stateKey);

    if (!stateData) {
      return res.status(404).json({ error: 'Task state not found' });
    }

    const state = JSON.parse(stateData);
    const claudeExecutionEntry = state.history.find(h => h.state === 'claude_execution' && h.metadata?.containerId);

    if (!claudeExecutionEntry || !claudeExecutionEntry.metadata?.containerId) {
      return res.status(404).json({ error: 'No Docker container info available for this task' });
    }

    const { containerId } = claudeExecutionEntry.metadata;

    // Get docker logs
    const { execSync } = require('child_process');
    try {
      const tailNum = parseInt(tail) || 100;
      const logsOutput = execSync(
        `docker logs --tail ${tailNum} ${containerId}`,
        { encoding: 'utf8', timeout: 10000, maxBuffer: 10 * 1024 * 1024 }
      );
      
      res.setHeader('Content-Type', 'text/plain');
      res.send(logsOutput);
    } catch (err) {
      // Container might be removed
      if (err.message.includes('No such container')) {
        return res.status(404).json({ 
          error: 'Container no longer exists (already removed)',
          containerId 
        });
      }
      throw err;
    }
  } catch (error) {
    console.error('Error in /api/task/:taskId/docker-logs:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

app.get('/api/task/:taskId/live-details', ensureAuthenticated, async (req, res) => {
  try {
    const { taskId: jobId } = req.params;

    // Compute the actual worker state taskId from the jobId
    // For regular issues: jobId format is "issue-{owner}-{repo}-{number}-{model}-{timestamp}"
    //                     taskId format is "{owner}-{repo}-{number}-{model}"
    // For PR comments: jobId format is "pr-comments-batch-{owner}-{repo}-{number}-{timestamp}"
    //                  taskId is the same as jobId
    let taskId = jobId;
    if (jobId.startsWith('issue-')) {
      // Remove "issue-" prefix and timestamp suffix
      const parts = jobId.replace(/^issue-/, '').split('-');
      // Last part is timestamp, remove it
      parts.pop();
      taskId = parts.join('-');
    }

    console.log(`[live-details] jobId: ${jobId}, taskId: ${taskId}`);

    const stateKey = `worker:state:${taskId}`;
    const stateData = await redisClient.get(stateKey);

    console.log(`[live-details] stateKey: ${stateKey}, hasData: ${!!stateData}`);

    if (!stateData) {
      console.log('[live-details] No state data found');
      return res.json({ events: [], todos: [], currentTask: null });
    }

    const state = JSON.parse(stateData);
    const claudeExecutionEntry = state.history.find(h => h.state === 'claude_execution' && h.metadata?.sessionId);

    console.log(`[live-details] Found claudeExecutionEntry: ${!!claudeExecutionEntry}, sessionId: ${claudeExecutionEntry?.metadata?.sessionId}`);

    if (!claudeExecutionEntry) {
      console.log('[live-details] No claude_execution entry with sessionId');
      return res.json({ events: [], todos: [], currentTask: null });
    }

    const { sessionId } = claudeExecutionEntry.metadata;

    console.log(`[live-details] sessionId: ${sessionId}`);

    // For running tasks, read from the actual .claude conversation file
    // Claude stores conversation files in ~/.claude/projects/-home-node-workspace/{sessionId}.jsonl
    const os = require('os');
    const claudeConversationPath = path.join(os.homedir(), '.claude', 'projects', '-home-node-workspace', `${sessionId}.jsonl`);

    console.log(`[live-details] Checking Claude conversation path: ${claudeConversationPath}`);

    const pathExists = await fs.pathExists(claudeConversationPath);

    if (!pathExists) {
      console.log('[live-details] Claude conversation file not found');
      return res.json({ events: [], todos: [], currentTask: null });
    }

    // Read and parse the JSONL file (each line is a JSON object)
    const conversationContent = await fs.readFile(claudeConversationPath, 'utf8');
    const lines = conversationContent.trim().split('\n').filter(line => line.trim());

    const events = [];
    let todos = [];

    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        const timestamp = message.timestamp || new Date().toISOString();

        if (message.type === 'assistant' && message.message?.content) {
          for (const content of message.message.content) {
            if (content.type === 'text') {
              events.push({ type: 'thought', content: content.text, timestamp });
            } else if (content.type === 'tool_use') {
              events.push({ type: 'tool_use', toolName: content.name, input: content.input, id: content.id, timestamp });
              if (content.name === 'TodoWrite' && content.input?.todos) {
                todos = content.input.todos;
              }
            }
          }
        } else if (message.type === 'user' && message.message?.content) {
          for (const content of message.message.content) {
            if (content.type === 'tool_result') {
              events.push({ type: 'tool_result', toolUseId: content.tool_use_id, result: content.content, isError: content.is_error || false, timestamp });
            }
          }
        }
      } catch (parseError) {
        console.error(`[live-details] Error parsing line:`, parseError);
      }
    }
    
    const inProgressTask = todos.find(t => t.status === 'in_progress');
    const currentTask = inProgressTask ? inProgressTask.content : null;

    console.log(`[live-details] Returning: ${events.length} events, ${todos.length} todos, currentTask: ${currentTask ? 'yes' : 'no'}`);

    res.json({ events, todos, currentTask });
  } catch (error) {
    console.error(`Error in /api/task/:taskId/live-details:`, error);
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

app.get('/api/config/followup-keywords', ensureAuthenticated, async (req, res) => {
  try {
    const keywords = await configRepoManager.loadFollowupKeywords();
    res.json({ followup_keywords: keywords });
  } catch (error) {
    console.error('Error in /api/config/followup-keywords GET:', error);
    res.status(500).json({ error: 'Failed to load followup keywords' });
  }
});

app.post('/api/config/followup-keywords', ensureAuthenticated, async (req, res) => {
  const lockKey = 'config:keywords:lock';
  const lockValue = `${Date.now()}-${Math.random()}`;
  const lockTimeout = 30;

  try {
    const { followup_keywords } = req.body;

    if (!Array.isArray(followup_keywords)) {
      return res.status(400).json({ error: 'followup_keywords must be an array of strings' });
    }

    const acquired = await redisClient.set(lockKey, lockValue, {
      NX: true,
      EX: lockTimeout
    });

    if (!acquired) {
      return res.status(409).json({ error: 'Configuration is being updated. Please try again.' });
    }

    try {
      await configRepoManager.saveFollowupKeywords(
        followup_keywords,
        `Update PR followup keywords via UI by ${req.user.username}`
      );
      res.json({ success: true, followup_keywords });
    } finally {
      const currentLockValue = await redisClient.get(lockKey);
      if (currentLockValue === lockValue) {
        await redisClient.del(lockKey);
      }
    }
  } catch (error) {
    console.error('Error in /api/config/followup-keywords POST:', error);
    res.status(500).json({ error: 'Failed to update followup keywords' });
  }
});

app.get('/api/config/repos', ensureAuthenticated, async (req, res) => {
  try {
    await configRepoManager.cloneOrPullConfigRepo();
    const configRepoPath = process.env.CONFIG_REPO_PATH || path.join(process.cwd(), '.config_repo');
    const configPath = path.join(configRepoPath, 'config.json');
    const config = await fs.readJson(configPath);
    let repos = config.repos_to_monitor || [];

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

app.get('/api/config/settings', ensureAuthenticated, async (req, res) => {
  try {
    const settings = await configRepoManager.loadSettings();
    const envDefaults = {
      worker_concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
      github_user_whitelist: (process.env.GITHUB_USER_WHITELIST || '').split(',').filter(u => u.trim())
    };
    const mergedSettings = {
      worker_concurrency: settings.worker_concurrency || envDefaults.worker_concurrency,
      github_user_whitelist: settings.github_user_whitelist || envDefaults.github_user_whitelist
    };
    res.json(mergedSettings);
  } catch (error) {
    console.error('Error in /api/config/settings GET:', error);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

app.post('/api/config/settings', ensureAuthenticated, async (req, res) => {
  const lockKey = 'config:settings:lock';
  const lockValue = Date.now() + '-' + Math.random();
  const lockTimeout = 30;

  try {
    const { settings } = req.body;

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'settings object is required' });
    }

    const acquired = await redisClient.set(lockKey, lockValue, {
      NX: true,
      EX: lockTimeout
    });

    if (!acquired) {
      return res.status(409).json({ error: 'Configuration is being updated by another request. Please try again.' });
    }

    try {
      await configRepoManager.saveSettings(
        settings,
        'Update settings via UI by ' + req.user.username
      );
      res.json({ success: true, settings });
    } finally {
      const currentLockValue = await redisClient.get(lockKey);
      if (currentLockValue === lockValue) {
        await redisClient.del(lockKey);
      }
    }
  } catch (error) {
    console.error('Error in /api/config/settings POST:', error);
    res.status(500).json({ error: 'Failed to update settings' });
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