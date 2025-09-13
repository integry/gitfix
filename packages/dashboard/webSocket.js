const { WebSocketServer } = require('ws');
const Redis = require('redis');

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });
  const subscriber = Redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  });

  subscriber.connect().then(() => {
    console.log('WebSocket Redis subscriber connected');
  }).catch(err => {
    console.error('Failed to connect WebSocket Redis subscriber:', err);
  });

  wss.on('connection', async (ws, req) => {
    const urlParts = req.url.split('/');
    const taskId = urlParts[urlParts.length - 1];

    if (!taskId || taskId === 'ws') {
      ws.close(1008, 'Task ID required');
      return;
    }

    ws.taskId = taskId;
    const logChannel = `task-log:${taskId}`;
    const diffChannel = `task-diff:${taskId}`;

    const messageHandler = (message, channel) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: channel.includes('log') ? 'log' : 'diff',
          channel,
          data: message,
          timestamp: new Date().toISOString()
        }));
      }
    };

    try {
      await subscriber.subscribe(logChannel, messageHandler);
      await subscriber.subscribe(diffChannel, messageHandler);
      
      console.log(`Client connected for task ${taskId}`);
      
      ws.send(JSON.stringify({
        type: 'connected',
        taskId,
        timestamp: new Date().toISOString()
      }));
    } catch (err) {
      console.error(`Failed to subscribe to channels for task ${taskId}:`, err);
      ws.close(1011, 'Subscription failed');
      return;
    }

    ws.on('close', async () => {
      if (ws.taskId) {
        try {
          await subscriber.unsubscribe(logChannel);
          await subscriber.unsubscribe(diffChannel);
          console.log(`Client disconnected for task ${ws.taskId}`);
        } catch (err) {
          console.error(`Failed to unsubscribe from channels for task ${ws.taskId}:`, err);
        }
      }
    });

    ws.on('error', (err) => {
      console.error(`WebSocket error for task ${ws.taskId}:`, err);
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(interval);
    subscriber.disconnect();
  });

  return wss;
}

module.exports = { setupWebSocket };