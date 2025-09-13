const { WebSocketServer } = require('ws');
const { createClient } = require('redis');

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });
  
  const connections = new Map();

  wss.on('connection', (ws, req) => {
    const urlParts = req.url.split('/');
    const taskId = urlParts[urlParts.length - 1];

    if (!taskId || taskId === 'ws') {
      ws.close(1002, 'Task ID required');
      return;
    }

    console.log(`Client connected for task ${taskId}`);

    const subscriber = createClient({
      url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`
    });

    const connectionInfo = {
      taskId,
      subscriber,
      ws
    };

    connections.set(ws, connectionInfo);

    subscriber.connect().then(async () => {
      await subscriber.subscribe(`task-log:${taskId}`, (message) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'log',
            taskId,
            message,
            timestamp: new Date().toISOString()
          }));
        }
      });

      await subscriber.subscribe(`task-diff:${taskId}`, (message) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'diff',
            taskId,
            message,
            timestamp: new Date().toISOString()
          }));
        }
      });

      await subscriber.subscribe(`task-state:${taskId}`, (message) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'state',
            taskId,
            message,
            timestamp: new Date().toISOString()
          }));
        }
      });

      ws.send(JSON.stringify({
        type: 'connected',
        taskId,
        timestamp: new Date().toISOString()
      }));
    }).catch(err => {
      console.error(`Error connecting Redis subscriber for task ${taskId}:`, err);
      ws.close(1011, 'Failed to establish pub/sub connection');
    });

    ws.on('close', async () => {
      const info = connections.get(ws);
      if (info) {
        console.log(`Client disconnected for task ${info.taskId}`);
        try {
          await info.subscriber.unsubscribe(`task-log:${info.taskId}`);
          await info.subscriber.unsubscribe(`task-diff:${info.taskId}`);
          await info.subscriber.unsubscribe(`task-state:${info.taskId}`);
          await info.subscriber.disconnect();
        } catch (err) {
          console.error('Error during cleanup:', err);
        }
        connections.delete(ws);
      }
    });

    ws.on('error', (err) => {
      console.error(`WebSocket error for task ${taskId}:`, err);
    });

    ws.on('pong', () => {
      connectionInfo.isAlive = true;
    });
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const info = connections.get(ws);
      if (info) {
        if (info.isAlive === false) {
          console.log(`Terminating inactive connection for task ${info.taskId}`);
          ws.terminate();
          return;
        }
        info.isAlive = false;
        ws.ping();
      }
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  console.log('WebSocket server setup complete');
}

module.exports = { setupWebSocket };