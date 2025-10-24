import 'dotenv/config';
import { GITHUB_ISSUE_QUEUE_NAME, createWorker, issueQueue } from './queue/taskQueue.js';
import logger from './utils/logger.js';
import { buildClaudeDockerImage } from './claude/claudeService.js';
import Redis from 'ioredis';
import { loadSettings } from './config/configRepoManager.js';
import { processGitHubIssueJob } from './jobs/issueProcessor.js';
import { processPullRequestCommentJob } from './jobs/pullRequestCommentProcessor.js';
import { processTaskImportJob } from './jobs/taskImportProcessor.js';

/**
 * Resets worker queues by removing all jobs and clearing Redis data
 * @returns {Promise<void>}
 */
async function resetWorkerQueues() {
    const redis = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: process.env.REDIS_PORT || 6379
    });

    try {
        // Remove all jobs from the queue
        logger.info('Draining issue queue...');
        await issueQueue.drain();
        logger.info(`Issue queue drained`);

        // Clear any related Redis keys
        logger.info('Clearing Redis worker-related keys...');
        const workerKeys = await redis.keys('worker:*');
        const stateKeys = await redis.keys('task:state:*');
        const allKeys = [...workerKeys, ...stateKeys];
        
        if (allKeys.length > 0) {
            await redis.del(...allKeys);
            logger.info(`Deleted ${allKeys.length} Redis keys`);
        } else {
            logger.info('No worker-related Redis keys found to delete');
        }

        // Clear BullMQ internal structures
        logger.info('Cleaning BullMQ structures...');
        await issueQueue.obliterate({ force: true });
        logger.info('Queue obliterated successfully');

    } finally {
        await redis.quit();
    }
}

/**
 * Parses command-line arguments
 * @returns {Object} Parsed options
 */
function parseArguments() {
    const args = process.argv.slice(2);
    const options = {
        help: false,
        reset: false,
        concurrency: 1,
        queueName: GITHUB_ISSUE_QUEUE_NAME,
        heartbeat: true
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--reset') {
            options.reset = true;
        } else if (arg === '--concurrency' || arg === '-c') {
            const value = parseInt(args[++i], 10);
            if (!isNaN(value) && value > 0) {
                options.concurrency = value;
            }
        } else if (arg === '--no-heartbeat') {
            options.heartbeat = false;
        }
    }
    
    return options;
}

/**
 * Shows help message
 */
function showHelp() {
    console.log(`
GitHub Issue Worker

Usage: node worker.js [options]

Options:
  -h, --help              Show this help message
  --reset                 Reset worker queues before starting
  -c, --concurrency <n>   Number of jobs to process concurrently (default: 1)
  --no-heartbeat          Disable heartbeat reporting to Redis

Environment Variables:
  REDIS_HOST              Redis host (default: redis)
  REDIS_PORT              Redis port (default: 6379)
  WORKER_CONCURRENCY      Default concurrency if not specified via CLI
  WORKER_ID               Custom worker ID (default: auto-generated)

Examples:
  node worker.js                    Start worker with default settings
  node worker.js --reset            Reset queues and start worker
  node worker.js -c 3               Process up to 3 jobs concurrently
  node worker.js --no-heartbeat     Start without heartbeat reporting
`);
}

/**
 * Starts the worker with the specified options
 * @param {Object} options - Worker options
 * @returns {Promise<Worker>} The worker instance
 */
async function startWorker(options = {}) {
    const workerConcurrency = options.concurrency || parseInt(process.env.WORKER_CONCURRENCY || '1', 10);
    const workerId = process.env.WORKER_ID || `worker-${process.pid}-${Date.now()}`;
    
    logger.info({ 
        workerId,
        concurrency: workerConcurrency,
        heartbeat: options.heartbeat,
        queueName: options.queueName || GITHUB_ISSUE_QUEUE_NAME
    }, 'Starting worker with configuration');
    
    // Load settings from config repository
    const configRepoUrl = process.env.CONFIG_REPO_URL;
    if (configRepoUrl) {
        logger.info({ configRepoUrl }, 'Loading settings from config repository');
        try {
            const settings = await loadSettings();
            logger.info('Successfully loaded settings from config repository');
            
            // Log loaded configuration (excluding sensitive data)
            logger.debug({
                hasOpenAIKey: !!settings.openAiApiKey,
                defaultModel: settings.defaultModel,
                hasSlackWebhook: !!settings.slackWebhookUrl,
                hasCustomPrompts: !!settings.customPrompts
            }, 'Loaded configuration summary');
        } catch (error) {
            logger.warn({ error: error.message }, 'Failed to load settings from config repository, using defaults');
        }
    }
    
    // Setup heartbeat reporting
    const heartbeatRedis = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: process.env.REDIS_PORT || 6379
    });
    
    const sendHeartbeat = async () => {
        if (!options.heartbeat) return;
        
        try {
            const heartbeat = {
                workerId,
                timestamp: Date.now(),
                concurrency: workerConcurrency,
                status: 'active',
                pid: process.pid,
                uptime: process.uptime()
            };
            
            await heartbeatRedis.hset(
                'system:status:workers',
                workerId,
                JSON.stringify(heartbeat)
            );

            // Note: We only use hset for the hash, no need for sadd

            logger.debug({ workerId }, 'Heartbeat sent');
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to send heartbeat');
        }
    };
    
    // Send initial heartbeat
    await sendHeartbeat();
    
    // Set up heartbeat interval (every 30 seconds)
    const heartbeatInterval = setInterval(sendHeartbeat, 30000);
    
    // Ensure Claude Docker image is built before starting worker
    logger.info('Checking Claude Code Docker image...');
    const imageReady = await buildClaudeDockerImage();
    
    if (!imageReady) {
        logger.error('Failed to build Claude Code Docker image. Worker may not function properly.');
        // Continue anyway - worker can still handle Git operations
    } else {
        logger.info('Claude Code Docker image is ready');
    }
    
    const worker = createWorker(GITHUB_ISSUE_QUEUE_NAME, async (job) => {
        if (job.name === 'processGitHubIssue') {
            return processGitHubIssueJob(job);
        } else if (job.name === 'processPullRequestComment') {
            return processPullRequestCommentJob(job);
        } else if (job.name === 'processTaskImport') {
            return processTaskImportJob(job);
        } else {
            throw new Error(`Unknown job type: ${job.name}`);
        }
    }, { concurrency: workerConcurrency });

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        logger.info('Worker received SIGINT, shutting down gracefully...');
        await heartbeatRedis.hdel('system:status:workers', workerId);
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
        await worker.close();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Worker received SIGTERM, shutting down gracefully...');
        await heartbeatRedis.hdel('system:status:workers', workerId);
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
        await worker.close();
        process.exit(0);
    });

    return worker;
}

// Export for testing
export { processGitHubIssueJob, processPullRequestCommentJob, processTaskImportJob, startWorker };

// Start worker if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    const options = parseArguments();
    
    if (options.help) {
        showHelp();
        process.exit(0);
    }
    
    async function main() {
        try {
            if (options.reset) {
                logger.info('Reset flag detected, clearing worker queue data...');
                await resetWorkerQueues();
                logger.info('Worker reset completed successfully');
            }
            
            await startWorker(options);
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to start worker');
            process.exit(1);
        }
    }
    
    main();
}