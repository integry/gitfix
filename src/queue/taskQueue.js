import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import logger from '../utils/logger.js';
import 'dotenv/config';

// Redis configuration
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const connectionOptions = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null, // Important for BullMQ
    enableReadyCheck: false,
};

// Create Redis connection
const redisConnection = new Redis(connectionOptions);

redisConnection.on('connect', () => {
    logger.info('Successfully connected to Redis for BullMQ.');
});

redisConnection.on('error', (err) => {
    logger.error({ err }, 'Redis connection error for BullMQ.');
});

// Queue configuration
export const GITHUB_ISSUE_QUEUE_NAME = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';

// Create the issue processing queue
export const issueQueue = new Queue(GITHUB_ISSUE_QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 2000,
        },
        removeOnComplete: {
            age: 24 * 3600, // Keep completed jobs for 24 hours
            count: 1000,    // Keep max 1000 completed jobs
        },
        removeOnFail: {
            age: 7 * 24 * 3600, // Keep failed jobs for 7 days
        },
    },
});

issueQueue.on('error', (err) => {
    logger.error({ queue: GITHUB_ISSUE_QUEUE_NAME, err }, 'Queue error');
});

/**
 * Creates and starts a BullMQ worker
 * @param {string} queueName - The name of the queue to process
 * @param {Function} processorFunction - The async function to process jobs
 * @returns {Worker} The created worker instance
 */
export function createWorker(queueName, processorFunction) {
    const worker = new Worker(queueName, processorFunction, {
        connection: redisConnection,
        concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
        autorun: true,
    });

    worker.on('completed', (job, result) => {
        logger.info({ 
            jobId: job.id, 
            jobName: job.name, 
            result,
            duration: Date.now() - job.timestamp
        }, 'Job completed successfully');
    });

    worker.on('failed', (job, err) => {
        logger.error({ 
            jobId: job?.id, 
            jobName: job?.name, 
            data: job?.data, 
            errMessage: err.message, 
            stack: err.stack,
            attemptsMade: job?.attemptsMade
        }, 'Job failed');
    });

    worker.on('error', (err) => {
        logger.error({ 
            queue: queueName, 
            errMessage: err.message 
        }, 'Worker error');
    });

    worker.on('stalled', (jobId) => {
        logger.warn({ jobId }, 'Job stalled and will be retried');
    });

    logger.info({ 
        queue: queueName,
        concurrency: worker.opts.concurrency 
    }, 'Worker started and listening to queue');
    
    return worker;
}

/**
 * Gracefully shuts down the queue and Redis connection
 */
export async function shutdownQueue() {
    logger.info('Shutting down queue...');
    
    try {
        await issueQueue.close();
        await redisConnection.quit();
        logger.info('Queue shutdown complete');
    } catch (err) {
        logger.error({ err }, 'Error during queue shutdown');
        throw err;
    }
}