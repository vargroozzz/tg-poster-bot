// src/bot/handlers/callbacks/reply.ts
import { Context } from 'grammy';
import { bot } from '../../bot.js';
import { logger } from '../../../utils/logger.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { REPLY_CALLBACK_PATTERN, REPLY_FROM_QUEUE } from '../../../shared/constants/reply-callbacks.js';
import { getSessionService } from './shared.js';
import { queuePreviewMessageId } from './queue.js';
import { ScheduledPostRepository } from '../../../database/repositories/scheduled-post.repository.js';
import type { IScheduledPost } from '../../../database/models/scheduled-post.model.js';
import { MediaSenderService } from '../../../core/sending/media-sender.service.js';
import { withSpoilers } from '../../../core/sending/spoilers.js';

const REPLY_PROMPT = '💬 Send the content for this reply. You can forward a message or send any media/text.';

// Content types whose text is actually shown in the channel (stickers, dice, polls… aren't).
const QUOTABLE_TYPES = ['text', 'photo', 'video', 'document', 'animation', 'voice', 'audio', 'media_group'];

type QuoteOffer = 'sent' | 'shown' | 'no_text' | 'bulk_forward' | 'failed';

const PROMPTS: Record<QuoteOffer | 'plain', string> = {
  plain: REPLY_PROMPT,
  sent: '❝ Select text in the post above and reply to it with your content.',
  shown: '❝ Select text in the post preview above and reply to it with your content.',
  no_text: `This post has no text to quote.\n\n${REPLY_PROMPT}`,
  bulk_forward: `Quoting isn't supported for forwarded albums and threads.\n\n${REPLY_PROMPT}`,
  failed: `⚠️ Quoting isn't available right now.\n\n${REPLY_PROMPT}`,
};

// Gives the user the parent post as it will appear in the channel to quote-reply a fragment of:
// the quote's text and position then match the parent once it is posted. From /queue the preview
// is already on screen, so that is reused; otherwise the post is sent.
async function offerPostToQuote(
  ctx: Context,
  userId: number,
  sessionId: string,
  parent: IScheduledPost,
  fromQueue: boolean
): Promise<QuoteOffer> {
  if (!parent.content.text || !QUOTABLE_TYPES.includes(parent.content.type)) return 'no_text';

  const { action, originalForward: origin } = parent;
  // A forwarded album/thread is replied to via its first message, which may not hold the text.
  if (
    action === 'forward' &&
    ((origin.mediaGroupMessageIds?.length ?? 0) > 1 || (origin.replyChainMessageIds?.length ?? 0) > 1)
  ) {
    return 'bulk_forward';
  }

  const previewId = fromQueue ? queuePreviewMessageId(userId) : undefined;
  // A forward is posted with forwardMessage, so show exactly that rather than a re-render.
  const sourceId =
    previewId ??
    (action === 'forward'
      ? (await ctx.api.forwardMessage(userId, origin.chatId, origin.messageId)).message_id
      : await new MediaSenderService(ctx.api).sendMessage(
          userId,
          withSpoilers(parent.content, parent.spoilers),
          undefined,
          parent.textAbove
        ));
  await getSessionService().update(sessionId, { replyQuoteSourceId: sourceId });
  return previewId ? 'shown' : 'sent';
}

export function registerReply(): void {

  // 💬 Add reply — from the scheduled-post confirmation or the queue preview.
  // The quoted variant first offers the post itself to quote-reply to.
  bot.callbackQuery(REPLY_CALLBACK_PATTERN, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const [, source, quoted, parentPostId] = ctx.match ?? [];
      const fromId = ctx.from?.id;
      if (!parentPostId || !fromId) return;

      const parent = await new ScheduledPostRepository().findById(parentPostId);
      if (!parent) {
        await ctx.reply('❌ Post not found — it may have already been published or deleted.');
        return;
      }

      const session = await getSessionService().createForReply(fromId, parentPostId);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

      const offer = quoted
        ? await offerPostToQuote(ctx, fromId, session._id.toString(), parent, source === REPLY_FROM_QUEUE).catch(
            (error: unknown) => {
              // The reply session is already live — quoting is optional, so don't fail the flow.
              logger.warn('Could not offer the post to quote:', error);
              return 'failed' as const;
            }
          )
        : 'plain';

      await ctx.reply(PROMPTS[offer]);

      logger.debug(`Reply session created for user ${fromId}, parent post ${parentPostId}, quote: ${offer}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Failed to start reply flow. Please try again.',
        'Error in add reply callback'
      );
    }
  });

}
