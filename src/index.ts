import { logger } from './utils/logger.js';
import { config } from './config/index.js';
import { connectDatabase, disconnectDatabase } from './database/connection.js';
import { startBot, stopBot } from './bot/bot.js';

// Import handlers to register them
import './bot/handlers/command.handler.js';
import './bot/handlers/forward.handler.js';
import './bot/handlers/callback.handler.js';

async function main() {
  try {
    logger.info('Starting Telegram Channel Poster Bot...');
    logger.info(`Environment: ${config.nodeEnv}`);
    logger.info(`Timezone: ${config.timezone}`);

    // Connect to MongoDB
    await connectDatabase();

    // Start the bot
    await startBot();

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
