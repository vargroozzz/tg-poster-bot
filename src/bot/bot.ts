import { Bot } from 'grammy';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { parseCommandName, NON_OWNER_COMMANDS } from '../core/proposals/proposal.js';

export const bot = new Bot(config.botToken);

// Auth middleware. The owner may do anything. Non-owners (proposers) may send content
// to propose and use only the allowlisted commands; every other command is owner-only.
bot.use(async (ctx, next) => {
  if (!ctx.from) {
    return;
  }

  if (ctx.from.id !== config.authorizedUserId) {
    // grammy's bot.command() matches a leading /command in text OR caption, so the gate
    // must inspect both — otherwise a non-owner could smuggle an admin command in a
    // media caption (e.g. a photo captioned "/addchannel ...") past this check.
    const command = parseCommandName(ctx.message?.text ?? ctx.message?.caption);
    if (command && !NON_OWNER_COMMANDS.includes(command)) {
      logger.warn(`Unauthorized command "/${command}" from user ${ctx.from.id} (@${ctx.from.username})`);
      await ctx.reply('⛔️ You are not authorized to use this command.');
      return;
    }
    // Otherwise: fall through — content messages and propose-flow callbacks are allowed.
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
