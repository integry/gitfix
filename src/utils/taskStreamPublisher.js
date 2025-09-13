import Redis from 'ioredis';
import logger from './logger.js';

class TaskStreamPublisher {
  constructor() {
    this.publisher = new Redis({
      host: process.env.REDIS_HOST || 'redis',
      port: process.env.REDIS_PORT || 6379
    });
    
    this.publisher.on('error', (err) => {
      logger.error({ error: err.message }, 'Redis publisher error');
    });
    
    this.publisher.on('connect', () => {
      logger.info('Task stream publisher connected to Redis');
    });
  }

  /**
   * Publishes log data to the task log channel
   * @param {string} taskId - The task ID
   * @param {string} logData - The log data to publish
   */
  async publishLog(taskId, logData) {
    try {
      await this.publisher.publish(`task-log:${taskId}`, JSON.stringify({
        type: 'log',
        data: logData,
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      logger.error({ error: error.message, taskId }, 'Failed to publish log');
    }
  }

  /**
   * Publishes diff data to the task diff channel
   * @param {string} taskId - The task ID
   * @param {string} diffData - The diff data to publish
   */
  async publishDiff(taskId, diffData) {
    try {
      await this.publisher.publish(`task-diff:${taskId}`, JSON.stringify({
        type: 'diff',
        data: diffData,
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      logger.error({ error: error.message, taskId }, 'Failed to publish diff');
    }
  }

  /**
   * Publishes status update to the task status channel
   * @param {string} taskId - The task ID
   * @param {string} status - The status update
   * @param {Object} metadata - Additional metadata
   */
  async publishStatus(taskId, status, metadata = {}) {
    try {
      await this.publisher.publish(`task-status:${taskId}`, JSON.stringify({
        type: 'status',
        status,
        metadata,
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      logger.error({ error: error.message, taskId }, 'Failed to publish status');
    }
  }

  /**
   * Persists logs for a completed task
   * @param {string} taskId - The task ID
   * @param {string} logs - The complete logs
   */
  async persistLogs(taskId, logs) {
    try {
      await this.publisher.setex(`task:${taskId}:logs`, 604800, logs); // 7 days expiry
      logger.debug({ taskId }, 'Persisted task logs');
    } catch (error) {
      logger.error({ error: error.message, taskId }, 'Failed to persist logs');
    }
  }

  /**
   * Persists final diff for a completed task
   * @param {string} taskId - The task ID
   * @param {string} diff - The final diff
   */
  async persistDiff(taskId, diff) {
    try {
      await this.publisher.setex(`task:${taskId}:diff`, 604800, diff); // 7 days expiry
      logger.debug({ taskId }, 'Persisted task diff');
    } catch (error) {
      logger.error({ error: error.message, taskId }, 'Failed to persist diff');
    }
  }

  /**
   * Closes the Redis connection
   */
  async close() {
    try {
      await this.publisher.quit();
      logger.info('Task stream publisher disconnected from Redis');
    } catch (error) {
      logger.error({ error: error.message }, 'Error closing Redis publisher');
    }
  }
}

// Create a singleton instance
let publisherInstance = null;

export function getTaskStreamPublisher() {
  if (!publisherInstance) {
    publisherInstance = new TaskStreamPublisher();
  }
  return publisherInstance;
}

export default TaskStreamPublisher;