// src/bot/handlers/callbacks/queue.ts
import { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { bot } from '../../bot.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { logger } from '../../../utils/logger.js';
import { SessionState } from '../../../shared/constants/flow-states.js';
import { ScheduledPostRepository } from '../../../database/repositories/scheduled-post.repository.js';
import { getActivePostingChannels } from '../../../database/models/posting-channel.model.js';
import { QueueService } from '../../../core/queue/queue.service.js';
import { QueuePreviewSenderService } from '../../../core/queue/queue-preview-sender.service.js';
import { PreviewGeneratorService } from '../../../core/preview/preview-generator.service.js';
import { PreviewSenderService } from '../../../core/preview/preview-sender.service.js';
import { transformerService } from '../../../services/transformer.service.js';
import { CustomTextPreset } from '../../../database/models/custom-text-preset.model.js';
import { findNicknameByUserId, getNicknameOptions } from '../../../shared/helpers/nickname.helper.js';
import { NICKNAME_NONE_KEY } from '../../keyboards/nickname-select.keyboard.js';
import { createQueueChannelSelectKeyboard } from '../../keyboards/queue-channel-select.keyboard.js';
import { createQueueListKeyboard } from '../../keyboards/queue-list.keyboard.js';
import {
  createEditChannelSelectKeyboard,
  createEditForwardActionKeyboard,
  createEditTextHandlingKeyboard,
  createEditNicknameKeyboard,
  createEditCustomTextKeyboard,
} from '../../keyboards/edit-keyboards.js';
import type { TextHandling } from '../../../types/message.types.js';
import { formatSlotTime } from '../../../utils/time-slots.js';
import { getSessionService } from './shared.js';

const queueService = new QueueService();

interface QueuePreviewState {
  previewMessageIds: number[];
  queueMessageId: number;
  channelId: string;
  page: number;
}

const queuePreviewStateMap = new Map<number, QueuePreviewState>();

// ── Private helpers ───────────────────────────────────────────────────────────

async function renderQueuePage(
  ctx: Context,
  channelId: string,
  page: number,
  messageId?: number
): Promise<void> {
  const chatId = ctx.chatId;
  if (!chatId) return;

  const channels = await getActivePostingChannels();
  const channel = channels.find((ch) => ch.channelId === channelId);
  const channelTitle = channel?.channelTitle ?? channelId;

  const { posts, labels, totalCount, totalPages } = await queueService.getChannelQueuePage(
    channelId,
    page
  );

  // Clamp page if it's now beyond the last page (e.g. after deletion)
  const clampedPage = Math.min(page, totalPages);
  if (clampedPage !== page) {
    return renderQueuePage(ctx, channelId, clampedPage, messageId);
  }

  const header = `📋 ${channelTitle} — Queue (${totalCount} post${totalCount !== 1 ? 's' : ''})`;

  if (posts.length === 0) {
    const text = `${header}\n\nNo pending posts.`;
    const keyboard = new InlineKeyboard().text('← Channels', 'queue:channels');
    if (messageId) {
      await ctx.api.editMessageText(chatId, messageId, text, { reply_markup: keyboard });
    } else {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    }
    return;
  }

  const postLines = posts
    .map((post, i) => {
      const time = formatSlotTime(post.scheduledTime);
      return `${(clampedPage - 1) * 5 + i + 1}. ${time} — ${labels[i]}`;
    })
    .join('\n');

  const text = `${header}\n\n${postLines}`;
  const keyboard = createQueueListKeyboard({
    postIds: posts.map((p) => p._id.toString()),
    channelId,
    page: clampedPage,
    totalPages,
  });

  if (messageId) {
    await ctx.api.editMessageText(chatId, messageId, text, { reply_markup: keyboard });
  } else {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  }
}

async function showEditPreview(ctx: Context, sessionId: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const sessionSvc = getSessionService();
  const session = await sessionSvc.findById(sessionId);
  if (!session) {
    await ctx.reply('❌ Edit session expired. Use /queue to start again.');
    return;
  }

  try {
    const previewGenerator = new PreviewGeneratorService();
    const previewContent = await previewGenerator.generatePreview(session);

    const previewSender = new PreviewSenderService(ctx.api);
    await previewSender.sendPreview(userId, previewContent, sessionId);

    await ctx.deleteMessage().catch(() => {});
    await sessionSvc.updateState(sessionId, SessionState.PREVIEW, {});
    logger.debug(`Edit preview shown for session ${sessionId}`);
  } catch (error) {
    logger.error('Error showing edit preview:', error);
    await ctx.editMessageText('❌ Preview generation failed. Please try again.');
  }
}

async function showEditNicknameStep(ctx: Context, sessionId: string): Promise<void> {
  const sessionSvc = getSessionService();
  const session = await sessionSvc.findById(sessionId);
  if (!session) return;

  const fromUserId = session.editingOriginalForward?.fromUserId;
  if (fromUserId) {
    const autoNickname = await findNicknameByUserId(fromUserId);
    if (autoNickname) {
      await sessionSvc.update(sessionId, { selectedUserId: fromUserId });
      const keyboard = await createEditCustomTextKeyboard(sessionId);
      await ctx.editMessageText('Do you want to add custom text to this post?', {
        reply_markup: keyboard,
      });
      return;
    }
  }

  const options = await getNicknameOptions();
  const keyboard = createEditNicknameKeyboard(options, sessionId);
  await ctx.editMessageText('Who should be credited for this post?', {
    reply_markup: keyboard,
  });
}

export function registerQueue(): void {

  // ── Queue browsing callbacks ──────────────────────────────────────────────────

  // queue:noop — pagination label button, does nothing
  bot.callbackQuery('queue:noop', async (ctx: Context) => {
    await ctx.answerCallbackQuery().catch(() => {});
  });

  // queue:channels — back to channel selection screen
  bot.callbackQuery('queue:channels', async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const channels = await getActivePostingChannels();

      if (channels.length === 0) {
        await ctx.editMessageText('⚠️ No posting channels configured. Use /addchannel first.');
        return;
      }

      const keyboard = createQueueChannelSelectKeyboard(channels);
      await ctx.editMessageText('📋 Select a channel to view its queue:', { reply_markup: keyboard });
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error loading channels.', 'queue:channels');
    }
  });

  // queue:ch:{channelId}:{page} — show paginated queue for a channel
  bot.callbackQuery(/^queue:ch:(.+):(\d+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const match = ctx.callbackQuery?.data?.match(/^queue:ch:(.+):(\d+)$/);
      if (!match) return;

      const channelId = match[1];
      const page = parseInt(match[2], 10);

      await renderQueuePage(ctx, channelId, page);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error loading queue.', 'queue:ch callback');
    }
  });

  // queue:preview:{postId}:{channelId}:{page} — send preview of a scheduled post
  bot.callbackQuery(/^queue:preview:([^:]+):(.+):(\d+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const match = ctx.callbackQuery?.data?.match(/^queue:preview:([^:]+):(.+):(\d+)$/);
      if (!match) return;

      const postId = match[1];
      const channelId = match[2];
      const page = parseInt(match[3], 10);
      const userId = ctx.from?.id;
      const queueMessageId = ctx.callbackQuery?.message?.message_id;

      if (!userId || !queueMessageId) return;

      const repository = new ScheduledPostRepository();
      const post = await repository.findById(postId);
      if (!post) {
        await ctx.reply('❌ Post not found — it may have already been published or deleted.');
        return;
      }

      const previewSender = new QueuePreviewSenderService(ctx.api);
      const { previewMessageIds } = await previewSender.sendPreview(userId, post);

      queuePreviewStateMap.set(userId, {
        previewMessageIds,
        queueMessageId,
        channelId,
        page,
      });
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error generating preview.', 'queue:preview callback');
    }
  });

  // queue:del:{postId} — delete post, cascade reschedule, refresh queue
  bot.callbackQuery(/^queue:del:(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const match = ctx.callbackQuery?.data?.match(/^queue:del:(.+)$/);
      if (!match) return;

      const postId = match[1];
      const userId = ctx.from?.id;
      if (!userId) return;

      const state = queuePreviewStateMap.get(userId);
      if (!state) {
        await ctx.reply('❌ Preview state expired. Please use /queue again.');
        return;
      }

      const { previewMessageIds, queueMessageId, channelId, page } = state;
      queuePreviewStateMap.delete(userId);

      const result = await queueService.deleteAndCascade(postId);

      // Always clean up preview messages regardless of whether the post was found
      await Promise.all(
        previewMessageIds.map((msgId) =>
          ctx.api.deleteMessage(userId, msgId).catch((err) =>
            logger.warn(`Failed to delete preview message ${msgId}:`, err)
          )
        )
      );
      await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));

      if (!result) {
        await ctx.reply('❌ Post not found — it may have already been published or deleted.');
      }

      // Refresh the queue list message (even if post was already gone, to show current state)
      await renderQueuePage(ctx, channelId, page, queueMessageId);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error deleting post.', 'queue:del callback');
    }
  });

  // queue:back — clean up preview messages, leave queue list unchanged
  bot.callbackQuery('queue:back', async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const userId = ctx.from?.id;
      if (!userId) return;

      const state = queuePreviewStateMap.get(userId);
      if (!state) {
        // State gone (bot restarted) — just delete the control message
        await ctx.deleteMessage().catch(() => {});
        return;
      }

      const { previewMessageIds } = state;
      queuePreviewStateMap.delete(userId);

      await Promise.all(
        previewMessageIds.map((msgId) =>
          ctx.api.deleteMessage(userId, msgId).catch((err) =>
            logger.warn(`Failed to delete preview message ${msgId}:`, err)
          )
        )
      );

      await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error going back.', 'queue:back callback');
    }
  });

  // ── Queue edit callbacks ──────────────────────────────────────────────────────

  // queue:edit:{postId} — entry point for editing a scheduled post
  bot.callbackQuery(/^queue:edit:([a-f0-9]{24})$/, async (ctx: Context) => {
    try {
      const postId = (ctx.match as RegExpExecArray)[1];
      const userId = ctx.from?.id;
      if (!userId) return;

      const repository = new ScheduledPostRepository();
      const post = await repository.findById(postId);
      if (!post) {
        await ctx.answerCallbackQuery({ text: '❌ Post already published or deleted', show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery().catch(() => {});

      // Clean up stale preview messages for this user
      const state = queuePreviewStateMap.get(userId);
      if (state) {
        await Promise.all(
          state.previewMessageIds.map((msgId) =>
            ctx.api.deleteMessage(userId, msgId).catch(() => {})
          )
        );
        queuePreviewStateMap.delete(userId);
      }
      await ctx.deleteMessage().catch(() => {});

      const sessionSvc = getSessionService();
      if (!sessionSvc) {
        await ctx.reply('❌ Service unavailable. Please try again.');
        return;
      }

      const session = await sessionSvc.createForEdit(userId, post);
      const sessionId = session._id.toString();

      const channels = await getActivePostingChannels();
      if (channels.length === 0) {
        await ctx.reply('⚠️ No posting channels configured.');
        return;
      }

      const keyboard = createEditChannelSelectKeyboard(channels, sessionId);
      await ctx.api.sendMessage(userId, '📍 Select target channel:', {
        reply_markup: keyboard,
      });

      logger.debug(`Edit session ${sessionId} started for user ${userId}, post ${postId}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error starting edit.', 'queue:edit entry');
    }
  });

  // queue:edit:ch:{sessionId}:{channelId} — channel selection for edit flow
  bot.callbackQuery(/^queue:edit:ch:([^:]+):(-?\d+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const [, sessionId, channelId] = ctx.match as RegExpExecArray;

      const sessionSvc = getSessionService();
      const session = await sessionSvc.findById(sessionId);
      if (!session) {
        await ctx.reply('❌ Edit session expired. Use /queue to start again.');
        return;
      }

      const isGreenListed = session.editingOriginalForward
        ? await transformerService.shouldAutoForward(session.editingOriginalForward)
        : false;
      const isRedListed = session.editingOriginalForward?.fromChannelId
        ? await transformerService.isRedListed(String(session.editingOriginalForward.fromChannelId))
        : false;
      const rawContent = session.editingRawContent;
      if (!rawContent) {
        await ctx.reply('❌ Edit session is corrupted. Please start over.');
        return;
      }
      const hasText = !!(rawContent.text && rawContent.text.trim().length > 0);
      const hasBlockquotes = hasText && (rawContent.text?.includes('<blockquote>') ?? false);
      const effectiveHasText = hasText && !hasBlockquotes;
      const isPoll = rawContent.type === 'poll';

      await sessionSvc.updateState(sessionId, SessionState.CHANNEL_SELECT, {
        selectedChannel: channelId,
      });

      if (isPoll) {
        await sessionSvc.updateState(sessionId, SessionState.PREVIEW, { selectedAction: 'forward' });
        await showEditPreview(ctx, sessionId);
        return;
      }

      if (isGreenListed) {
        await sessionSvc.updateState(sessionId, SessionState.PREVIEW, { selectedAction: 'forward' });
        await showEditPreview(ctx, sessionId);
        return;
      }

      if (isRedListed) {
        await sessionSvc.update(sessionId, { selectedAction: 'transform' });
        if (hasBlockquotes) await sessionSvc.update(sessionId, { textHandling: 'keep' });
        if (effectiveHasText) {
          await ctx.editMessageText('How should the text be handled?', {
            reply_markup: createEditTextHandlingKeyboard(sessionId),
          });
        } else {
          await showEditNicknameStep(ctx, sessionId);
        }
        return;
      }

      await ctx.editMessageText(
        'Choose how to post this message:\n⚡ <b>Quick post</b> — transform, no attribution, no extra text',
        { reply_markup: createEditForwardActionKeyboard(sessionId), parse_mode: 'HTML' }
      );
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting channel.', 'queue:edit:ch');
    }
  });

  // queue:edit:action:{sessionId}:{action} — action selection for edit flow
  bot.callbackQuery(/^queue:edit:action:([^:]+):(transform|forward|quick)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const [, sessionId, action] = ctx.match as RegExpExecArray;

      const sessionSvc = getSessionService();
      const session = await sessionSvc.findById(sessionId);
      if (!session) {
        await ctx.reply('❌ Edit session expired. Use /queue to start again.');
        return;
      }

      const rawContent = session.editingRawContent;
      if (!rawContent) {
        await ctx.reply('❌ Edit session is corrupted. Please start over.');
        return;
      }
      const hasText = !!(rawContent.text && rawContent.text.trim().length > 0);
      const hasBlockquotes = hasText && (rawContent.text?.includes('<blockquote>') ?? false);
      const effectiveHasText = hasText && !hasBlockquotes;

      if (action === 'quick') {
        await sessionSvc.updateState(sessionId, SessionState.PREVIEW, {
          selectedAction: 'transform',
          textHandling: 'remove',
          selectedUserId: session.editingOriginalForward?.fromUserId ?? null,
          customText: undefined,
        });
        await showEditPreview(ctx, sessionId);
        return;
      }

      if (action === 'forward') {
        await sessionSvc.updateState(sessionId, SessionState.PREVIEW, { selectedAction: 'forward' });
        await showEditPreview(ctx, sessionId);
        return;
      }

      if (hasBlockquotes) await sessionSvc.update(sessionId, { selectedAction: 'transform', textHandling: 'keep' });
      else await sessionSvc.update(sessionId, { selectedAction: 'transform' });
      if (effectiveHasText) {
        await ctx.editMessageText('How should the text be handled?', {
          reply_markup: createEditTextHandlingKeyboard(sessionId),
        });
      } else {
        await showEditNicknameStep(ctx, sessionId);
      }
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting action.', 'queue:edit:action');
    }
  });

  // queue:edit:text:{sessionId}:{textHandling} — text handling for edit flow
  bot.callbackQuery(/^queue:edit:text:([^:]+):(keep|remove|quote)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const [, sessionId, textHandling] = ctx.match as RegExpExecArray;

      const sessionSvc = getSessionService();
      const session = await sessionSvc.findById(sessionId);
      if (!session) {
        await ctx.reply('❌ Edit session expired. Use /queue to start again.');
        return;
      }

      await sessionSvc.update(sessionId, {
        textHandling: textHandling as TextHandling,
      });
      await showEditNicknameStep(ctx, sessionId);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting text handling.', 'queue:edit:text');
    }
  });

  // queue:edit:nickname:{sessionId}:{nicknameKey} — nickname selection for edit flow
  bot.callbackQuery(/^queue:edit:nickname:([^:]+):([^:]+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const [, sessionId, nicknameKey] = ctx.match as RegExpExecArray;

      const sessionSvc = getSessionService();
      const session = await sessionSvc.findById(sessionId);
      if (!session) {
        await ctx.reply('❌ Edit session expired. Use /queue to start again.');
        return;
      }

      const parsedUserId = parseInt(nicknameKey, 10);
      const selectedUserId = nicknameKey === NICKNAME_NONE_KEY || isNaN(parsedUserId) ? null : parsedUserId;

      await sessionSvc.update(sessionId, { selectedUserId });

      const keyboard = await createEditCustomTextKeyboard(sessionId);
      await ctx.editMessageText('Do you want to add custom text to this post?', {
        reply_markup: keyboard,
      });
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting nickname.', 'queue:edit:nickname');
    }
  });

  // queue:edit:custom:{sessionId}:{choice} — custom text choice for edit flow
  bot.callbackQuery(/^queue:edit:custom:([^:]+):(add|skip)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const [, sessionId, choice] = ctx.match as RegExpExecArray;

      const sessionSvc = getSessionService();
      const session = await sessionSvc.findById(sessionId);
      if (!session) {
        await ctx.reply('❌ Edit session expired. Use /queue to start again.');
        return;
      }

      if (choice === 'skip') {
        await sessionSvc.updateState(sessionId, SessionState.PREVIEW, { customText: undefined });
        await showEditPreview(ctx, sessionId);
      } else {
        await sessionSvc.updateState(sessionId, SessionState.CUSTOM_TEXT, {
          waitingForCustomText: true,
        });
        await ctx.editMessageText(
          '✍️ Reply to this message with your custom text.\n\nThis text will be added at the beginning of your post.'
        );
      }
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error with custom text.', 'queue:edit:custom');
    }
  });

  // ec:preset:{sessionId}:{presetId} — shortened to stay under Telegram's 64-byte callback_data limit
  bot.callbackQuery(/^ec:preset:([^:]+):(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const [, sessionId, presetId] = ctx.match as RegExpExecArray;

      const sessionSvc = getSessionService();
      const session = await sessionSvc.findById(sessionId);
      if (!session) {
        await ctx.reply('❌ Edit session expired. Use /queue to start again.');
        return;
      }

      const preset = await CustomTextPreset.findById(presetId).lean();
      if (!preset) {
        await ctx.editMessageText('❌ Preset not found. It may have been deleted.');
        return;
      }

      await sessionSvc.updateState(sessionId, SessionState.PREVIEW, { customText: preset.text });
      await showEditPreview(ctx, sessionId);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting preset.', 'ec:preset');
    }
  });

}
