import http from 'http';
import { logger } from './utils/logger.js';
import { config } from './config/index.js';
import { connectDatabase, disconnectDatabase } from './database/connection.js';
import { startBot, stopBot, bot } from './bot/bot.js';
import { PostWorkerService } from './services/post-worker.service.js';

// Import handlers to register them
import './bot/handlers/command.handler.js';
import './bot/handlers/forward.handler.js';
import './bot/handlers/callback.handler.js';

let server: http.Server | null = null;
let postWorker: PostWorkerService | null = null;

async function main() {
  try {
    logger.info('Starting Telegram Channel Poster Bot...');
    logger.info(`Environment: ${config.nodeEnv}`);
    logger.info(`Timezone: ${config.timezone}`);

    // Connect to MongoDB
    await connectDatabase();

    // Start the bot
    await startBot();

    // Start post worker for scheduled publishing
    postWorker = new PostWorkerService(bot.api);
    postWorker.start();

    // Start HTTP server for health checks
    const port = process.env.PORT ?? 3000;
    const healthResponse = JSON.stringify({ status: 'ok', service: 'telegram-poster-bot' });
    const notFoundResponse = JSON.stringify({ error: 'Not found' });

    server = http.createServer((req, res) => {
      const isHealthEndpoint = req.url === '/health' || req.url === '/';

      res.writeHead(isHealthEndpoint ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(isHealthEndpoint ? healthResponse : notFoundResponse);
    });

    server.listen(port, () => {
      logger.info(`Health check server listening on port ${port}`);
    });

    logger.info('Bot is running...');
  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down gracefully...');

  try {
    // Stop post worker
    if (postWorker) {
      postWorker.stop();
    }

    // Close HTTP server
    if (server) {
      await new Promise<void>((resolve) => {
        server?.close(() => {
          logger.info('HTTP server closed');
          resolve();
        });
      });
    }

    await stopBot();
    await disconnectDatabase();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the application
main();
