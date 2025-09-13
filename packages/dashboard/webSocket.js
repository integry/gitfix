const { WebSocketServer } = require('ws');
const { createClient } = require('redis');

let wss;
let subscriber;
const taskClients = new Map(); // Map of taskId to Set of WebSocket clients

async function setupWebSocket(server) {
  wss = new WebSocketServer({ server });
  
  // Create a dedicated Redis client for subscribing
  subscriber = createClient({
    url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`
  });
  
  subscriber.on('error', (err) => console.error('Redis Subscriber Error', err));
  await subscriber.connect();
  
  // Handle Redis Pub/Sub messages
  subscriber.on('message', (channel, message) => {
    const [prefix, type, taskId] = channel.split(':');
    
    if (prefix === 'task' && taskId) {
      const clients = taskClients.get(taskId);
      if (clients && clients.size > 0) {
        const data = {
          type,
          taskId,
          message,
          timestamp: new Date().toISOString()
        };
        
        // Send to all clients watching this task
        clients.forEach(client => {
          if (client.readyState === client.OPEN) {
            client.send(JSON.stringify(data));
          }
        });
      }
    }
  });
  
  wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection');
    
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        
        if (message.type === 'subscribe' && message.taskId) {
          // Subscribe to task channels
          const taskId = message.taskId;
          
          // Add client to taskClients map
          if (!taskClients.has(taskId)) {
            taskClients.set(taskId, new Set());
            // Subscribe to Redis channels for this task
            await subscriber.subscribe(`task:log:${taskId}`);
            await subscriber.subscribe(`task:diff:${taskId}`);
            console.log(`Subscribed to channels for task ${taskId}`);
          }
          
          taskClients.get(taskId).add(ws);
          ws.taskId = taskId;
          
          // Send confirmation
          ws.send(JSON.stringify({
            type: 'subscribed',
            taskId,
            timestamp: new Date().toISOString()
          }));
        }
        
        if (message.type === 'unsubscribe' && ws.taskId) {
          handleClientUnsubscribe(ws);
        }
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
          timestamp: new Date().toISOString()
        }));
      }
    });
    
    ws.on('close', () => {
      if (ws.taskId) {
        handleClientUnsubscribe(ws);
      }
      console.log('WebSocket connection closed');
    });
    
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
    
    // Send initial connection acknowledgment
    ws.send(JSON.stringify({
      type: 'connected',
      timestamp: new Date().toISOString()
    }));
  });
  
  console.log('WebSocket server initialized');
}

async function handleClientUnsubscribe(ws) {
  const taskId = ws.taskId;
  const clients = taskClients.get(taskId);
  
  if (clients) {
    clients.delete(ws);
    
    // If no more clients are watching this task, unsubscribe from Redis
    if (clients.size === 0) {
      taskClients.delete(taskId);
      await subscriber.unsubscribe(`task:log:${taskId}`);
      await subscriber.unsubscribe(`task:diff:${taskId}`);
      console.log(`Unsubscribed from channels for task ${taskId}`);
    }
  }
  
  delete ws.taskId;
}

module.exports = { setupWebSocket };