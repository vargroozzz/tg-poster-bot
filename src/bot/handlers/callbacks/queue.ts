// src/bot/handlers/callbacks/queue.ts
import { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { bot } from '../../bot.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { EDIT_POST_PATTERN, editStepPattern } from '../../../shared/constants/edit-callbacks.js';
import { QUEUE_BACK, QUEUE_DELETE_PATTERN } from '../../../shared/constants/queue-callbacks.js';
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
import { NICKNAME_NONE_KEY } from '../../keyboards/nickname-select.keyboard.js';
import { createQueueChannelSelectKeyboard } from '../../keyboards/queue-channel-select.keyboard.js';
import { createQueueListKeyboard } from '../../keyboards/queue-list.keyboard.js';
import { channelLabel } from '../../../shared/helpers/channel.helper.js';
import { createChannelSelectKeyboard } from '../../keyboards/channel-select.keyboard.js';
import { createForwardActionKeyboard } from '../../keyboards/forward-action.keyboard.js';
import { flowCallbacks } from '../../keyboards/flow-callbacks.js';
import type { TextHandling } from '../../../types/message.types.js';
import { formatSlotTime } from '../../../utils/time-slots.js';
import { editEntryBlocker } from './edit-entry.js';
import {
  type QueuePreviewState,
  saveQueuePreview,
  takeQueuePreview,
  takeQueuePreviewsOfPost,
} from './queue-preview-state.js';
import {
  actionPrompt,
  CUSTOM_TEXT_PROMPT,
  NICKNAME_PROMPT,
  TEXT_CHOICE_PROMPT,
  editNicknameKeyboard,
  getSessionService,
  textChoiceKeyboardFor,
} from './shared.js';

const queueService = new QueueService();

// ── Private helpers ───────────────────────────────────────────────────────────

/** Deletes these queue previews' messages: the post as it will appear, and the control message. */
async function deletePreviewMessages(ctx: Context, userId: number, previews: QueuePreviewState[]): Promise<void> {
  await Promise.all(
    previews
      .flatMap((state) => [...state.previewMessageIds, state.controlMessageId])
      .map((msgId) =>
        ctx.api.deleteMessage(userId, msgId).catch((err) =>
          logger.warn(`Failed to delete queue preview message ${msgId}:`, err)
        )
      )
  );
}

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
  const channelTitle = channel ? channelLabel(channel) : channelId;

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

// Same one-tap step as the post flow: the original text, a custom one, or none.
async function showEditTextChoiceStep(ctx: Context, sessionId: string): Promise<void> {
  await ctx.editMessageText(TEXT_CHOICE_PROMPT, {
    reply_markup: await textChoiceKeyboardFor(sessionId, flowCallbacks('edit', sessionId)),
  });
}

async function showEditNicknameStep(ctx: Context, sessionId: string): Promise<void> {
  const keyboard = await editNicknameKeyboard(sessionId);
  if (!keyboard) {
    await showEditPreview(ctx, sessionId);
    return;
  }

  await ctx.editMessageText(NICKNAME_PROMPT, { reply_markup: keyboard });
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
      const { previewMessageIds, controlMessageId } = await previewSender.sendPreview(userId, post);

      saveQueuePreview(userId, {
        previewMessageIds,
        postId,
        controlMessageId,
        queueMessageId,
        channelId,
        page,
      });
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error generating preview.', 'queue:preview callback');
    }
  });

  // queue:del:{postId} — delete post, cascade reschedule, refresh queue
  bot.callbackQuery(QUEUE_DELETE_PATTERN, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const postId = (ctx.match as RegExpExecArray)[1];
      const userId = ctx.from?.id;
      const controlMessageId = ctx.callbackQuery?.message?.message_id;
      if (!userId || !controlMessageId) return;

      // Taken up front so a second tap finds no preview; put back if the delete throws, so
      // Delete or Back on it can still clean it up. Missing (bot restarted), the delete still runs.
      const state = takeQueuePreview(userId, controlMessageId);
      const result = await queueService.deleteAndCascade(postId).catch((error: unknown) => {
        if (state) saveQueuePreview(userId, state);
        throw error;
      });

      // Every open preview of the post goes, found or not: none of them shows a queued post now.
      const previews = [...(state ? [state] : []), ...takeQueuePreviewsOfPost(userId, postId)];
      await deletePreviewMessages(ctx, userId, previews);
      if (!state) await ctx.deleteMessage().catch(() => {});

      if (!result) {
        await ctx.reply('❌ Post not found — it may have already been published or deleted.');
      }

      // Refresh the queue list message (even if post was already gone, to show current state)
      if (state) await renderQueuePage(ctx, state.channelId, state.page, state.queueMessageId);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error deleting post.', 'queue:del callback');
    }
  });

  // queue:back — clean up preview messages, leave queue list unchanged
  bot.callbackQuery(QUEUE_BACK, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const userId = ctx.from?.id;
      const controlMessageId = ctx.callbackQuery?.message?.message_id;
      if (!userId || !controlMessageId) return;

      const state = takeQueuePreview(userId, controlMessageId);
      if (!state) {
        // State gone (bot restarted) — just delete the control message
        await ctx.deleteMessage().catch(() => {});
        return;
      }

      await deletePreviewMessages(ctx, userId, [state]);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error going back.', 'queue:back callback');
    }
  });

  // ── Queue edit callbacks ──────────────────────────────────────────────────────

  // queue:edit:{postId} — entry point for editing a scheduled post
  bot.callbackQuery(EDIT_POST_PATTERN, async (ctx: Context) => {
    try {
      const postId = (ctx.match as RegExpExecArray)[1];
      const userId = ctx.from?.id;
      if (!userId) return;

      const repository = new ScheduledPostRepository();
      const [post, channels] = await Promise.all([
        repository.findById(postId),
        getActivePostingChannels(),
      ]);
      if (!post) {
        await ctx.answerCallbackQuery({ text: '❌ Post already published or deleted', show_alert: true }).catch(() => {});
        return;
      }
      const blocker = editEntryBlocker(post, channels.length);
      if (blocker) {
        await ctx.answerCallbackQuery({ text: blocker, show_alert: true }).catch(() => {});
        return;
      }

      await ctx.answerCallbackQuery().catch(() => {});

      // Session first: if it fails, the tapped message and its Edit button are still there.
      const session = await getSessionService().createForEdit(userId, post);
      const sessionId = session._id.toString();

      // The open queue previews of this post go: the edit makes them stale.
      // A preview of another post stays, even when Edit was tapped on a confirmation.
      const stalePreviews = takeQueuePreviewsOfPost(userId, postId);
      await deletePreviewMessages(ctx, userId, stalePreviews);
      // Tapped on one of those previews, the tapped message is already gone.
      const tappedMessageId = ctx.callbackQuery?.message?.message_id;
      if (!stalePreviews.some((state) => state.controlMessageId === tappedMessageId)) {
        await ctx.deleteMessage().catch(() => {});
      }

      await ctx.api.sendMessage(userId, '📍 Select target channel:', {
        reply_markup: createChannelSelectKeyboard(channels, flowCallbacks('edit', sessionId)),
      });

      logger.debug(`Edit session ${sessionId} started for user ${userId}, post ${postId}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error starting edit.', 'queue:edit entry');
    }
  });

  // queue:edit:ch:{sessionId}:{channelId} — channel selection for edit flow
  bot.callbackQuery(editStepPattern('channel'), async (ctx: Context) => {
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

      await sessionSvc.updateState(sessionId, SessionState.CHANNEL_SELECT, {
        selectedChannel: channelId,
      });

      // A reply can't be forwarded, so a green-listed one goes through the action choice.
      if (rawContent.type === 'poll' || (isGreenListed && !session.isReply)) {
        await sessionSvc.updateState(sessionId, SessionState.PREVIEW, { selectedAction: 'forward' });
        await showEditPreview(ctx, sessionId);
        return;
      }

      if (isRedListed) {
        await sessionSvc.updateState(sessionId, SessionState.TEXT_HANDLING, { selectedAction: 'transform' });
        await showEditTextChoiceStep(ctx, sessionId);
        return;
      }

      await ctx.editMessageText(actionPrompt(session.isReply ? 'reply' : 'message'), {
        reply_markup: createForwardActionKeyboard(flowCallbacks('edit', sessionId), session.isReply),
        parse_mode: 'HTML',
      });
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting channel.', 'queue:edit:ch');
    }
  });

  // queue:edit:action:{sessionId}:{action} — action selection for edit flow
  bot.callbackQuery(editStepPattern('action'), async (ctx: Context) => {
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

      if (action === 'quick') {
        await sessionSvc.updateState(sessionId, SessionState.PREVIEW, {
          selectedAction: 'transform',
          textHandling: rawContent.type === 'text' ? 'keep' : 'remove',
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

      await sessionSvc.updateState(sessionId, SessionState.TEXT_HANDLING, { selectedAction: 'transform' });
      await showEditTextChoiceStep(ctx, sessionId);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting action.', 'queue:edit:action');
    }
  });

  // queue:edit:text:{sessionId}:{textHandling} — text handling for edit flow
  bot.callbackQuery(editStepPattern('text'), async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const [, sessionId, textHandling] = ctx.match as RegExpExecArray;

      const sessionSvc = getSessionService();
      const session = await sessionSvc.findById(sessionId);
      if (!session) {
        await ctx.reply('❌ Edit session expired. Use /queue to start again.');
        return;
      }

      // Picking the original text (or none) drops any custom text the post carried.
      await sessionSvc.updateState(sessionId, SessionState.NICKNAME_SELECT, {
        textHandling: textHandling as TextHandling,
        customText: undefined,
      });
      await showEditNicknameStep(ctx, sessionId);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting text handling.', 'queue:edit:text');
    }
  });

  // queue:edit:nickname:{sessionId}:{nicknameKey} — nickname selection for edit flow
  bot.callbackQuery(editStepPattern('nickname'), async (ctx: Context) => {
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

      await sessionSvc.updateState(sessionId, SessionState.PREVIEW, { selectedUserId });
      await showEditPreview(ctx, sessionId);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting nickname.', 'queue:edit:nickname');
    }
  });

  // queue:edit:custom:{sessionId}:add — typed custom text for edit flow
  bot.callbackQuery(editStepPattern('addText'), async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const [, sessionId] = ctx.match as RegExpExecArray;

      const sessionSvc = getSessionService();
      const session = await sessionSvc.findById(sessionId);
      if (!session) {
        await ctx.reply('❌ Edit session expired. Use /queue to start again.');
        return;
      }

      await sessionSvc.updateState(sessionId, SessionState.CUSTOM_TEXT, {
        waitingForCustomText: true,
      });
      await ctx.editMessageText(CUSTOM_TEXT_PROMPT);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error with custom text.', 'queue:edit:custom');
    }
  });

  // ec:preset:{sessionId}:{presetId} — shortened to stay under Telegram's 64-byte callback_data limit
  bot.callbackQuery(editStepPattern('preset'), async (ctx: Context) => {
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

      // A custom text replaces the message's own, exactly as in the post flow.
      await sessionSvc.updateState(sessionId, SessionState.NICKNAME_SELECT, {
        customText: preset.text,
        textHandling: 'remove',
      });
      await showEditNicknameStep(ctx, sessionId);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting preset.', 'ec:preset');
    }
  });

}
