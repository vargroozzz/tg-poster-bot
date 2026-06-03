// src/bot/handlers/callbacks/reply.ts
import { Context } from 'grammy';
import { bot } from '../../bot.js';
import { logger } from '../../../utils/logger.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { getSessionService } from './shared.js';

export function registerReply(): void {

  // Triggered from post confirmation message after scheduling
  bot.callbackQuery(/^reply_trigger:(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const parentPostId = ctx.callbackQuery?.data?.match(/^reply_trigger:(.+)$/)?.[1];
      if (!parentPostId) {
        await ctx.answerCallbackQuery({ text: 'Invalid post reference.' });
        return;
      }

      const fromId = ctx.from?.id;
      if (!fromId) return;

      const sessionSvc = getSessionService();
      await sessionSvc.createForReply(fromId, parentPostId);

      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.reply('💬 Send the content for this reply. You can forward a message or send any media/text.');

      logger.debug(`Reply session created for user ${fromId}, parent post ${parentPostId}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Failed to start reply flow. Please try again.',
        'Error in reply_trigger callback'
      );
    }
  });

  // Triggered from queue preview action keyboard
  bot.callbackQuery(/^queue_reply:(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const postId = ctx.callbackQuery?.data?.match(/^queue_reply:(.+)$/)?.[1];
      if (!postId) {
        await ctx.answerCallbackQuery({ text: 'Invalid post reference.' });
        return;
      }

      const fromId = ctx.from?.id;
      if (!fromId) return;

      const sessionSvc = getSessionService();
      await sessionSvc.createForReply(fromId, postId);

      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.reply('💬 Send the content for this reply. You can forward a message or send any media/text.');

      logger.debug(`Reply session created from queue for user ${fromId}, post ${postId}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Failed to start reply flow. Please try again.',
        'Error in queue_reply callback'
      );
    }
  });

}
