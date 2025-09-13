const { WebSocketServer } = require('ws');
const { createClient } = require('redis');

class TaskWebSocketServer {
  constructor(server) {
    this.wss = new WebSocketServer({ server });
    this.subscriber = null;
    this.publisher = null;
    this.clientTaskMap = new Map();
    this.init();
  }

  async init() {
    try {
      this.subscriber = createClient({
        url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`
      });
      
      this.publisher = createClient({
        url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`
      });

      await this.subscriber.connect();
      await this.publisher.connect();

      this.subscriber.on('error', (err) => console.error('Redis Subscriber Error:', err));
      this.publisher.on('error', (err) => console.error('Redis Publisher Error:', err));

      this.setupWebSocketHandlers();
      console.log('WebSocket server initialized');
    } catch (error) {
      console.error('Failed to initialize WebSocket server:', error);
    }
  }

  setupWebSocketHandlers() {
    this.wss.on('connection', (ws, req) => {
      console.log('New WebSocket connection');
      
      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message);
          
          if (data.type === 'subscribe' && data.taskId) {
            await this.handleSubscribe(ws, data.taskId);
          } else if (data.type === 'unsubscribe' && data.taskId) {
            await this.handleUnsubscribe(ws, data.taskId);
          }
        } catch (error) {
          console.error('WebSocket message error:', error);
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(ws);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.handleDisconnect(ws);
      });
    });
  }

  async handleSubscribe(ws, taskId) {
    try {
      const channels = [`task-log:${taskId}`, `task-diff:${taskId}`, `task-status:${taskId}`];
      
      for (const channel of channels) {
        await this.subscriber.subscribe(channel, (message) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: 'data',
              channel: channel,
              taskId: taskId,
              data: message,
              timestamp: new Date().toISOString()
            }));
          }
        });
      }

      this.clientTaskMap.set(ws, taskId);
      
      ws.send(JSON.stringify({
        type: 'subscribed',
        taskId: taskId,
        channels: channels
      }));

      console.log(`Client subscribed to task ${taskId}`);
    } catch (error) {
      console.error('Subscribe error:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to subscribe' }));
    }
  }

  async handleUnsubscribe(ws, taskId) {
    try {
      const channels = [`task-log:${taskId}`, `task-diff:${taskId}`, `task-status:${taskId}`];
      
      for (const channel of channels) {
        await this.subscriber.unsubscribe(channel);
      }

      this.clientTaskMap.delete(ws);
      
      ws.send(JSON.stringify({
        type: 'unsubscribed',
        taskId: taskId
      }));

      console.log(`Client unsubscribed from task ${taskId}`);
    } catch (error) {
      console.error('Unsubscribe error:', error);
    }
  }

  async handleDisconnect(ws) {
    const taskId = this.clientTaskMap.get(ws);
    if (taskId) {
      await this.handleUnsubscribe(ws, taskId);
    }
    this.clientTaskMap.delete(ws);
  }

  async publishTaskUpdate(taskId, channel, data) {
    try {
      await this.publisher.publish(`${channel}:${taskId}`, JSON.stringify(data));
    } catch (error) {
      console.error('Publish error:', error);
    }
  }
}

module.exports = { TaskWebSocketServer };