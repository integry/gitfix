import { createClient } from 'redis';
import logger from './logger.js';

class TaskDataPersistence {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  async connect() {
    if (this.isConnected) return;

    this.client = createClient({
      url: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`
    });

    this.client.on('error', (err) => {
      logger.error({ error: err }, 'Redis TaskDataPersistence Client Error');
    });

    await this.client.connect();
    this.isConnected = true;
    logger.info('TaskDataPersistence Redis client connected');
  }

  async persistTaskCompletion(taskId, data) {
    if (!this.isConnected) await this.connect();

    const persistenceData = {
      taskId,
      completedAt: new Date().toISOString(),
      ...data
    };

    // Store task completion data
    await this.client.setEx(
      `task:${taskId}:data`,
      86400 * 7, // Keep for 7 days
      JSON.stringify(persistenceData)
    );

    // Store raw output if available
    if (data.rawOutput) {
      await this.client.setEx(
        `task:${taskId}:output`,
        86400 * 7, // Keep for 7 days
        data.rawOutput
      );
    }

    // Store final diff if available
    if (data.finalDiff) {
      await this.client.setEx(
        `task:${taskId}:diff`,
        86400 * 7, // Keep for 7 days
        data.finalDiff
      );
    }

    // Add to activity log
    const activityEntry = {
      timestamp: new Date().toISOString(),
      type: data.success ? 'task_completed' : 'task_failed',
      taskId,
      issueNumber: data.issueNumber,
      repository: data.repository,
      message: data.success 
        ? `Task ${taskId} completed successfully`
        : `Task ${taskId} failed: ${data.error}`
    };

    await this.client.lPush(
      'system:activity:log',
      JSON.stringify(activityEntry)
    );

    // Trim activity log to keep only last 1000 entries
    await this.client.lTrim('system:activity:log', 0, 999);

    logger.info({ taskId, success: data.success }, 'Task completion data persisted');
  }

  async getTaskData(taskId) {
    if (!this.isConnected) await this.connect();

    const [data, output, diff] = await Promise.all([
      this.client.get(`task:${taskId}:data`),
      this.client.get(`task:${taskId}:output`),
      this.client.get(`task:${taskId}:diff`)
    ]);

    return {
      data: data ? JSON.parse(data) : null,
      output,
      diff
    };
  }

  async disconnect() {
    if (this.client && this.isConnected) {
      await this.client.disconnect();
      this.isConnected = false;
    }
  }
}

export default new TaskDataPersistence();