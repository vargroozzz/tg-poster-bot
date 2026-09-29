// src/bot/handlers/callbacks/reply.ts
import { Context } from 'grammy';
import { bot } from '../../bot.js';
import { logger } from '../../../utils/logger.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { getSessionService } from './shared.js';
import { ScheduledPostRepository } from '../../../database/repositories/scheduled-post.repository.js';

// Content types whose text is actually shown in the channel (stickers, dice, polls… aren't).
const QUOTABLE_TYPES = ['text', 'photo', 'video', 'document', 'animation', 'voice', 'audio', 'media_group'];

// Sends the parent's text as its own message so the user can quote-reply a fragment of it:
// the quote's text and position then match the parent as it is posted in the channel.
async function promptForReply(ctx: Context, sessionId: string, parentPostId: string): Promise<void> {
  await ctx.reply('💬 Send the content for this reply. You can forward a message or send any media/text.');

  try {
    const parent = await new ScheduledPostRepository().findById(parentPostId);
    const text = parent?.content.text;
    // A forwarded album/thread is replied to via its first message, which may not hold the text.
    const bulk =
      parent?.action === 'forward' &&
      ((parent.originalForward.mediaGroupMessageIds?.length ?? 0) > 1 ||
        (parent.originalForward.replyChainMessageIds?.length ?? 0) > 1);
    if (!parent || !text || bulk || !QUOTABLE_TYPES.includes(parent.content.type)) return;

    const echo = await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    await getSessionService().update(sessionId, { replyQuoteSourceId: echo.message_id });
    await ctx.reply('❝ To quote part of the post, select text in the message above and reply to it with your content.');
  } catch (error) {
    // The reply session is already live — quoting is optional, so don't report the flow as failed.
    logger.warn('Could not offer a quote of the parent post:', error);
  }
}

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
      const session = await sessionSvc.createForReply(fromId, parentPostId);

      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await promptForReply(ctx, session._id.toString(), parentPostId);

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
      const session = await sessionSvc.createForReply(fromId, postId);

      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await promptForReply(ctx, session._id.toString(), postId);

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
