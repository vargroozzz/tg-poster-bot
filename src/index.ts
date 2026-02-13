import http from 'http';
import { webhookCallback } from 'grammy';
import { logger } from './utils/logger.js';
import { config } from './config/index.js';
import { connectDatabase, disconnectDatabase } from './database/connection.js';
import { initBot, bot } from './bot/bot.js';
import { PostWorkerService } from './services/post-worker.service.js';
import { DIContainer } from './shared/di/container.js';

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

    // Initialize the bot
    await initBot();

    // Initialize DI container with all services
    DIContainer.initialize(bot.api);
    logger.info('DI Container initialized with all services');

    // Set webhook if WEBHOOK_URL is provided, otherwise use long polling
    const webhookUrl = process.env.WEBHOOK_URL;
    const webhookPath = '/webhook';

    if (webhookUrl) {
      logger.info(`Setting up webhook at ${webhookUrl}${webhookPath}`);
      await bot.api.setWebhook(`${webhookUrl}${webhookPath}`);
    } else {
      logger.warn('No WEBHOOK_URL provided, using long polling (not recommended for production)');
    }

    // Start post worker for scheduled publishing
    postWorker = new PostWorkerService(bot.api);

    // Only run continuous worker in local development (not on Render with cron job)
    const useCronJob = process.env.USE_CRON_JOB === 'true';
    if (useCronJob) {
      logger.info('Using Render Cron Job for scheduled posts (continuous worker disabled)');
    } else {
      logger.info('Starting continuous post worker (local development mode)');
      postWorker.start();
    }

    // Start HTTP server for health checks and webhooks
    const port = process.env.PORT ?? 3000;
    const healthResponse = JSON.stringify({ status: 'ok', service: 'telegram-poster-bot' });
    const notFoundResponse = JSON.stringify({ error: 'Not found' });

    // Create webhook handler
    const handleWebhook = webhookCallback(bot, 'http');

    server = http.createServer(async (req, res) => {
      // Handle webhook
      if (req.url === webhookPath && req.method === 'POST') {
        try {
          await handleWebhook(req, res);
        } catch (error) {
          logger.error('Error handling webhook:', error);
          res.writeHead(500);
          res.end();
        }
        return;
      }

      // Process scheduled posts endpoint (for Render Cron Job)
      if (req.url === '/process-posts' && req.method === 'POST') {
        try {
          logger.info('Processing scheduled posts via HTTP endpoint');
          if (postWorker) {
            // Trigger immediate processing
            await postWorker.processNow();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', message: 'Posts processed' }));
          } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Post worker not initialized' }));
          }
        } catch (error) {
          logger.error('Error processing posts:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to process posts' }));
        }
        return;
      }

      // Health check endpoint
      const isHealthEndpoint = req.url === '/health' || req.url === '/';
      res.writeHead(isHealthEndpoint ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(isHealthEndpoint ? healthResponse : notFoundResponse);
    });

    server.listen(port, async () => {
      logger.info(`Server listening on port ${port}`);

      // If no webhook, start long polling
      if (!webhookUrl) {
        logger.info('Starting long polling...');
        bot.start().catch((error) => {
          logger.error('Error in long polling:', error);
        });
      }
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

    // Stop bot if running in long polling mode
    if (!process.env.WEBHOOK_URL) {
      await bot.stop();
      logger.info('Bot stopped');
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
