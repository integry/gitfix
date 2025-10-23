import 'dotenv/config';
import { GITHUB_ISSUE_QUEUE_NAME, createWorker } from './queue/taskQueue.js';
import logger from './utils/logger.js';
import Redis from 'ioredis';

// Import job processors
import { processGitHubIssueJob } from './jobs/issueProcessor.js';
import { processPullRequestCommentJob } from './jobs/prCommentProcessor.js';
import { processTaskImportJob } from './jobs/taskImportProcessor.js';

// Initialize worker concurrency from environment variable
const workerConcurrency = parseInt(process.env.WORKER_CONCURRENCY || '3', 10);

// Create a unique worker ID
const workerId = `worker-${process.env.HOSTNAME || 'local'}-${Date.now()}`;

// Initialize Redis for heartbeats
const heartbeatRedis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: process.env.REDIS_PORT || 6379,
    lazyConnect: true
});

const HEARTBEAT_INTERVAL = 30000; // 30 seconds
let heartbeatInterval;

async function initializeWorker() {
    try {
        // Connect to Redis
        await heartbeatRedis.connect();
        logger.info({ workerId }, 'Worker heartbeat Redis connected');

        // Register worker
        await heartbeatRedis.sadd('system:status:workers', workerId);
        await heartbeatRedis.hset(`worker:${workerId}`, 'started', new Date().toISOString());
        await heartbeatRedis.expire(`worker:${workerId}`, 120); // 2 minutes expiry

        // Set up heartbeat
        heartbeatInterval = setInterval(async () => {
            try {
                await heartbeatRedis.hset(`worker:${workerId}`, 'heartbeat', new Date().toISOString());
                await heartbeatRedis.expire(`worker:${workerId}`, 120); // Reset expiry
            } catch (error) {
                logger.error({ error: error.message }, 'Failed to send worker heartbeat');
            }
        }, HEARTBEAT_INTERVAL);

        logger.info({ workerId, concurrency: workerConcurrency }, 'Worker initialized');
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to initialize worker');
        throw error;
    }
}

// Main worker creation
const worker = createWorker(GITHUB_ISSUE_QUEUE_NAME, async (job) => {
    const jobName = job.name;
    logger.info({
        jobId: job.id,
        jobName,
        attemptNumber: job.attemptsMade + 1,
        maxAttempts: job.opts?.attempts || 1
    }, 'Worker processing job');

    try {
        let result;
        
        switch (jobName) {
            case 'processGitHubIssue':
                result = await processGitHubIssueJob(job);
                break;
                
            case 'processPullRequestComment':
                result = await processPullRequestCommentJob(job);
                break;
                
            case 'processTaskImport':
                result = await processTaskImportJob(job);
                break;
                
            default:
                throw new Error(`Unknown job type: ${jobName}`);
        }
        
        logger.info({
            jobId: job.id,
            jobName,
            status: result?.status || 'complete'
        }, 'Job completed successfully');
        
        return result;
        
    } catch (error) {
        logger.error({
            jobId: job.id,
            jobName,
            error: error.message,
            stack: error.stack,
            attemptNumber: job.attemptsMade + 1,
            willRetry: (job.attemptsMade + 1) < (job.opts?.attempts || 1)
        }, 'Job processing failed');
        
        throw error; // Re-throw to let BullMQ handle retries
    }
}, { concurrency: workerConcurrency });

// Handle worker events
worker.on('completed', (job, returnvalue) => {
    logger.info({
        jobId: job.id,
        jobName: job.name,
        duration: job.finishedOn - job.processedOn
    }, 'Job completed event');
});

worker.on('failed', (job, err) => {
    logger.error({
        jobId: job?.id,
        jobName: job?.name,
        error: err.message,
        failedReason: job?.failedReason,
        attemptsMade: job?.attemptsMade
    }, 'Job failed event');
});

worker.on('error', (err) => {
    logger.error({
        error: err.message,
        stack: err.stack
    }, 'Worker error event');
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Worker received SIGINT, shutting down gracefully...');
    
    try {
        // Clean up heartbeat
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
        
        // Remove worker from active set
        await heartbeatRedis.srem('system:status:workers', workerId);
        await heartbeatRedis.del(`worker:${workerId}`);
        await heartbeatRedis.quit();
        
        // Close worker
        await worker.close();
        
        logger.info('Worker shutdown complete');
        process.exit(0);
    } catch (error) {
        logger.error({ error: error.message }, 'Error during worker shutdown');
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    logger.info('Worker received SIGTERM, shutting down gracefully...');
    
    try {
        // Clean up heartbeat
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
        
        // Remove worker from active set
        await heartbeatRedis.srem('system:status:workers', workerId);
        await heartbeatRedis.del(`worker:${workerId}`);
        await heartbeatRedis.quit();
        
        // Close worker
        await worker.close();
        
        logger.info('Worker shutdown complete');
        process.exit(0);
    } catch (error) {
        logger.error({ error: error.message }, 'Error during worker shutdown');
        process.exit(1);
    }
});

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error({
        reason: reason?.message || reason,
        stack: reason?.stack
    }, 'Unhandled promise rejection');
});

// Initialize and start the worker
initializeWorker().catch((error) => {
    logger.fatal({ error: error.message }, 'Failed to start worker');
    process.exit(1);
});

export { worker };