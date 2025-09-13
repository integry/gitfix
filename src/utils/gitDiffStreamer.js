import simpleGit from 'simple-git';
import redisPublisher from './redisPublisher.js';
import logger from './logger.js';

class GitDiffStreamer {
  constructor() {
    this.intervals = new Map();
  }

  async streamDiff(taskId, worktreePath) {
    try {
      const git = simpleGit(worktreePath);
      const diff = await git.diff();
      
      if (diff) {
        await redisPublisher.publishDiff(taskId, diff);
        logger.debug({ taskId, diffLength: diff.length }, 'Published git diff to Redis');
      }
    } catch (error) {
      logger.error({ taskId, error }, 'Failed to get or publish git diff');
    }
  }

  startStreaming(taskId, worktreePath, intervalMs = 5000) {
    if (this.intervals.has(taskId)) {
      logger.warn({ taskId }, 'Diff streaming already active for task');
      return;
    }

    logger.info({ taskId, worktreePath, intervalMs }, 'Starting git diff streaming');
    
    // Stream initial diff
    this.streamDiff(taskId, worktreePath);
    
    // Set up periodic streaming
    const intervalId = setInterval(() => {
      this.streamDiff(taskId, worktreePath);
    }, intervalMs);
    
    this.intervals.set(taskId, intervalId);
  }

  stopStreaming(taskId) {
    const intervalId = this.intervals.get(taskId);
    if (intervalId) {
      clearInterval(intervalId);
      this.intervals.delete(taskId);
      logger.info({ taskId }, 'Stopped git diff streaming');
    }
  }

  async getFinalDiff(worktreePath) {
    try {
      const git = simpleGit(worktreePath);
      const diff = await git.diff();
      return diff;
    } catch (error) {
      logger.error({ error }, 'Failed to get final git diff');
      return null;
    }
  }

  stopAll() {
    for (const [taskId, intervalId] of this.intervals) {
      clearInterval(intervalId);
      logger.info({ taskId }, 'Stopped git diff streaming during cleanup');
    }
    this.intervals.clear();
  }
}

export default new GitDiffStreamer();