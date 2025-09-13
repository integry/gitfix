const { createClient } = require('redis');

class RedisPublisher {
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
      console.error('Redis Publisher Error:', err);
    });

    await this.client.connect();
    this.isConnected = true;
    console.log('Redis Publisher connected');
  }

  async publishLog(taskId, message) {
    if (!this.isConnected) await this.connect();
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      message,
      type: 'log'
    };
    
    await this.client.publish(`task-log:${taskId}`, JSON.stringify(logEntry));
  }

  async publishDiff(taskId, diff) {
    if (!this.isConnected) await this.connect();
    
    const diffEntry = {
      timestamp: new Date().toISOString(),
      diff,
      type: 'diff'
    };
    
    await this.client.publish(`task-diff:${taskId}`, JSON.stringify(diffEntry));
  }

  async publishState(taskId, state) {
    if (!this.isConnected) await this.connect();
    
    const stateEntry = {
      timestamp: new Date().toISOString(),
      state,
      type: 'state'
    };
    
    await this.client.publish(`task-state:${taskId}`, JSON.stringify(stateEntry));
  }

  async publishProgress(taskId, progress) {
    if (!this.isConnected) await this.connect();
    
    const progressEntry = {
      timestamp: new Date().toISOString(),
      progress,
      type: 'progress'
    };
    
    await this.client.publish(`task-progress:${taskId}`, JSON.stringify(progressEntry));
  }

  async disconnect() {
    if (this.client && this.isConnected) {
      await this.client.disconnect();
      this.isConnected = false;
    }
  }
}

const redisPublisher = new RedisPublisher();

module.exports = redisPublisher;