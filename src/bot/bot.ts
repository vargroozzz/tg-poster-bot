import { Bot } from 'grammy';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export const bot = new Bot(config.botToken);

// Auth middleware - only allow authorized user
bot.use(async (ctx, next) => {
  if (!ctx.from) {
    return;
  }

  if (ctx.from.id !== config.authorizedUserId) {
    logger.warn(`Unauthorized access attempt from user ${ctx.from.id} (@${ctx.from.username})`);
    await ctx.reply('⛔️ You are not authorized to use this bot.');
    return;
  }

  await next();
});

// Logging middleware
bot.use(async (ctx, next) => {
  const updateType = ctx.update.message
    ? 'message'
    : ctx.update.callback_query
    ? 'callback_query'
    : 'other';
  logger.debug(`Received update: ${updateType}`, {
    updateId: ctx.update.update_id,
    from: ctx.from?.id,
  });

  await next();
});

// Error handler
bot.catch((err) => {
  logger.error('Bot error:', err.error);
});

export async function initBot(): Promise<void> {
  try {
    // Initialize bot to fetch bot info
    await bot.init();
    logger.info(`Bot initialized: @${bot.botInfo.username}`);
  } catch (error) {
    logger.error('Failed to initialize bot:', error);
    throw error;
  }
}
