const { WebSocketServer } = require('ws');
const { createClient } = require('redis');

class WebSocketManager {
  constructor() {
    this.wss = null;
    this.subscriber = null;
    this.publisher = null;
    this.clientTaskMap = new Map(); // Maps WebSocket clients to task IDs
  }

  async setupWebSocket(server) {
    // Create WebSocket server
    this.wss = new WebSocketServer({ server });
    
    // Create Redis clients for pub/sub
    this.subscriber = createClient({
      url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`
    });
    
    this.publisher = createClient({
      url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`
    });
    
    await this.subscriber.connect();
    await this.publisher.connect();
    
    // Set up WebSocket connection handling
    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });
    
    console.log('WebSocket server initialized');
  }

  handleConnection(ws, req) {
    console.log('New WebSocket connection established');
    
    // Parse task ID from URL (e.g., /ws/tasks/task-123)
    const urlParts = req.url.split('/');
    const taskId = urlParts[urlParts.length - 1];
    
    if (taskId && taskId !== 'ws' && taskId !== 'tasks') {
      ws.taskId = taskId;
      
      // Store client-task mapping
      if (!this.clientTaskMap.has(taskId)) {
        this.clientTaskMap.set(taskId, new Set());
      }
      this.clientTaskMap.get(taskId).add(ws);
      
      // Subscribe to task channels
      this.subscribeToTask(taskId);
      
      console.log(`Client connected for task ${taskId}`);
      
      // Send initial connection confirmation
      ws.send(JSON.stringify({
        type: 'connection',
        taskId: taskId,
        message: 'Connected to task stream'
      }));
    }
    
    // Handle client messages
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        this.handleClientMessage(ws, data);
      } catch (error) {
        console.error('Invalid WebSocket message:', error);
      }
    });
    
    // Handle client disconnect
    ws.on('close', () => {
      if (ws.taskId) {
        const clients = this.clientTaskMap.get(ws.taskId);
        if (clients) {
          clients.delete(ws);
          if (clients.size === 0) {
            this.clientTaskMap.delete(ws.taskId);
            this.unsubscribeFromTask(ws.taskId);
          }
        }
        console.log(`Client disconnected for task ${ws.taskId}`);
      }
    });
    
    // Handle errors
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  }

  async subscribeToTask(taskId) {
    const channels = [
      `task-log:${taskId}`,
      `task-diff:${taskId}`,
      `task-status:${taskId}`
    ];
    
    // Subscribe with message handler for Redis v4
    for (const channel of channels) {
      await this.subscriber.subscribe(channel, (message) => {
        this.broadcastToTaskClients(channel, message);
      });
    }
    
    console.log(`Subscribed to channels for task ${taskId}`);
  }

  async unsubscribeFromTask(taskId) {
    const channels = [
      `task-log:${taskId}`,
      `task-diff:${taskId}`,
      `task-status:${taskId}`
    ];
    
    for (const channel of channels) {
      await this.subscriber.unsubscribe(channel);
    }
    
    console.log(`Unsubscribed from channels for task ${taskId}`);
  }

  broadcastToTaskClients(channel, message) {
    // Extract task ID from channel name
    const taskId = channel.split(':')[1];
    const clients = this.clientTaskMap.get(taskId);
    
    if (clients && clients.size > 0) {
      const messageType = channel.split(':')[0].replace('task-', '');
      const wsMessage = JSON.stringify({
        type: messageType,
        channel: channel,
        data: message,
        timestamp: new Date().toISOString()
      });
      
      // Send to all clients watching this task
      clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(wsMessage);
        }
      });
    }
  }

  handleClientMessage(ws, data) {
    // Handle any client-to-server messages if needed
    console.log('Received message from client:', data);
    
    // For now, just echo back a confirmation
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'ack',
        originalMessage: data
      }));
    }
  }

  // Utility method to publish messages (used by other parts of the system)
  async publishTaskUpdate(taskId, type, data) {
    const channel = `task-${type}:${taskId}`;
    await this.publisher.publish(channel, typeof data === 'string' ? data : JSON.stringify(data));
  }
}

module.exports = WebSocketManager;