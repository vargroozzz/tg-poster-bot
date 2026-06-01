// src/bot/handlers/callbacks/scheduling.ts
import { Context } from 'grammy';
import { bot } from '../../bot.js';
import { parseForwardInfo } from '../../../utils/message-parser.js';
import { transformerService } from '../../../services/transformer.service.js';
import { extractMessageContent } from '../forward.handler.js';
import { createForwardActionKeyboard } from '../../keyboards/forward-action.keyboard.js';
import { createTextHandlingKeyboard } from '../../keyboards/text-handling.keyboard.js';
import { createChannelSelectKeyboard } from '../../keyboards/channel-select.keyboard.js';
import { createCustomTextKeyboard } from '../../keyboards/custom-text.keyboard.js';
import { createEditChannelSelectKeyboard } from '../../keyboards/edit-keyboards.js';
import { CustomTextPreset } from '../../../database/models/custom-text-preset.model.js';
import { formatSlotTime } from '../../../utils/time-slots.js';
import { logger } from '../../../utils/logger.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { NICKNAME_NONE_KEY } from '../../keyboards/nickname-select.keyboard.js';
import { findNicknameByUserId } from '../../../shared/helpers/nickname.helper.js';
import { PostSchedulerService } from '../../../core/posting/post-scheduler.service.js';
import { SessionState } from '../../../shared/constants/flow-states.js';
import { getNextState } from '../../../core/session/session-state-machine.js';
import { PostingChannel, getActivePostingChannels } from '../../../database/models/posting-channel.model.js';
import { ScheduledPostRepository } from '../../../database/repositories/scheduled-post.repository.js';
import { QueueService } from '../../../core/queue/queue.service.js';
import type { ISession } from '../../../database/models/session.model.js';
import {
  getSessionService,
  deletePreviewMessages,
  showPreview,
  handleNicknameSelection,
} from './shared.js';

const postScheduler = new PostSchedulerService();
const queueService = new QueueService();

async function getPendingForward(userId: number, messageId: number): Promise<ISession | undefined> {
  const sessionSvc = getSessionService();
  if (!sessionSvc) return undefined;
  try {
    const session = await sessionSvc.findByMessage(userId, messageId);
    if (session) logger.debug(`Found session in DB for message ${messageId}`);
    return session ?? undefined;
  } catch (error) {
    logger.error('Error fetching session from DB:', error);
    return undefined;
  }
}

export function registerScheduling(): void {

  // Handle channel selection
  bot.callbackQuery(/^select_channel:(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const match = ctx.callbackQuery?.data?.match(/^select_channel:(.+)$/);
      const selectedChannelId = match?.[1];

      if (!selectedChannelId) {
        await ctx.editMessageText('❌ Invalid channel selection.');
        return;
      }

      // Find the original message
      const originalMessage = ctx.callbackQuery?.message?.reply_to_message;

      if (!originalMessage) {
        await ErrorMessages.originalMessageNotFound(ctx);
        return;
      }

      // Parse forward info to check green list
      const forwardInfo = parseForwardInfo(originalMessage);
      const shouldAutoForward = await transformerService.shouldAutoForward(forwardInfo);

      // Check if message has text
      const content = extractMessageContent(originalMessage);

      // DUAL READ: Try to find session in DB first, fall back to Map
      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      const foundKey = session?._id.toString();

      const sessionSvc = getSessionService();
      if (session && sessionSvc) {
        const nextState = getNextState(SessionState.CHANNEL_SELECT, {
          isGreenListed: shouldAutoForward,
          isRedListed: false,
          hasText: false,
          isForward: false,
        });
        await sessionSvc.updateState(session._id.toString(), nextState, {
          selectedChannel: selectedChannelId,
        });
      }

      if (!foundKey) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      if (shouldAutoForward) {
        if (session && sessionSvc) {
          await sessionSvc.update(session._id.toString(), { selectedAction: 'forward' });
        }
        await showPreview(ctx, foundKey);
        return;
      }

      // Polls cannot be transformed — always forward regardless of origin
      if (content?.type === 'poll') {
        if (session && sessionSvc) {
          await sessionSvc.update(session._id.toString(), { selectedAction: 'forward' });
          await showPreview(ctx, session._id.toString());
        }
        logger.debug(`Poll message ${originalMessage.message_id}: auto-selected forward`);
        return;
      }

      // Show action keyboard for all non-green, non-poll messages
      const keyboard = createForwardActionKeyboard();
      await ctx.editMessageText(
        'Choose how to post this message:\n⚡ <b>Quick post</b> — transform, no attribution, no extra text',
        { reply_markup: keyboard, parse_mode: 'HTML' }
      );

      logger.debug(`Channel ${selectedChannelId} selected for message ${originalMessage.message_id}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Error processing channel selection. Please try again.',
        'Error in channel selection callback'
      );
    }
  });

  // Handle custom text selection
  bot.callbackQuery(/^custom_text:(add|skip)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const match = ctx.callbackQuery?.data?.match(/^custom_text:(add|skip)$/);
      const action = match?.[1];

      if (!action) {
        await ErrorMessages.invalidSelection(ctx, 'action');
        return;
      }

      const originalMessage = ctx.callbackQuery?.message?.reply_to_message;

      if (!originalMessage) {
        await ErrorMessages.originalMessageNotFound(ctx);
        return;
      }

      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      const foundKey = session?._id.toString();

      if (!foundKey) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      const updates = action === 'add' ? { waitingForCustomText: true } : { customText: undefined };
      const nextState = action === 'add' ? SessionState.CUSTOM_TEXT : SessionState.PREVIEW;
      await getSessionService()?.updateState(foundKey, nextState, updates);

      if (action === 'add') {
        await ctx.editMessageText(
          '✍️ Reply to this message with your custom text.\n\n' +
            'This text will be added at the beginning of your post.'
        );
      } else {
        // Skip custom text - show preview
        await showPreview(ctx, foundKey);
      }

      logger.debug(`Custom text action "${action}" for message ${originalMessage.message_id}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Error processing custom text. Please try again.',
        'Error in custom text callback'
      );
    }
  });

  // Handle preset custom text selection
  bot.callbackQuery(/^custom_text:preset:(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const presetId = ctx.callbackQuery?.data?.match(/^custom_text:preset:(.+)$/)?.[1];
      if (!presetId) {
        await ErrorMessages.invalidSelection(ctx, 'preset');
        return;
      }

      const preset = await CustomTextPreset.findById(presetId).lean();
      if (!preset) {
        await ctx.editMessageText('❌ Preset not found. It may have been deleted.');
        return;
      }

      const originalMessage = ctx.callbackQuery?.message?.reply_to_message;
      if (!originalMessage) {
        await ErrorMessages.originalMessageNotFound(ctx);
        return;
      }

      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      const foundKey = session?._id.toString();
      if (!foundKey) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      await getSessionService()?.updateState(foundKey, SessionState.PREVIEW, { customText: preset.text });
      await showPreview(ctx, foundKey);

      logger.debug(`Preset custom text "${preset.label}" selected for message ${originalMessage.message_id}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Error selecting preset text. Please try again.',
        'Error in custom text preset callback'
      );
    }
  });

  // Handle nickname selection
  bot.callbackQuery(/^select_nickname:(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const match = ctx.callbackQuery?.data?.match(/^select_nickname:(.+)$/);
      const nicknameSelection = match?.[1];

      if (!nicknameSelection) {
        await ErrorMessages.invalidSelection(ctx, 'nickname');
        return;
      }

      // Find the original message
      const originalMessage = ctx.callbackQuery?.message?.reply_to_message;

      if (!originalMessage) {
        await ErrorMessages.originalMessageNotFound(ctx);
        return;
      }

      const selectedUserId = nicknameSelection === NICKNAME_NONE_KEY ? null : parseInt(nicknameSelection, 10);

      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      const foundKey = session?._id.toString();

      if (!foundKey) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      // Use the session's stored originalMessage (full data from DB) rather than
      // reply_to_message from the callback, which Telegram may truncate (e.g. strips forward_origin).
      const fullMessage = session?.originalMessage ?? originalMessage;
      const isPlainText =
        fullMessage.text !== undefined &&
        !('photo' in fullMessage && fullMessage.photo) &&
        !('video' in fullMessage && fullMessage.video) &&
        !('document' in fullMessage && fullMessage.document) &&
        !('animation' in fullMessage && fullMessage.animation) &&
        !('external_reply' in fullMessage && fullMessage.external_reply) &&
        !fullMessage.forward_origin;

      const nextState = getNextState(SessionState.NICKNAME_SELECT, {
        isGreenListed: false, isRedListed: false, hasText: false, isForward: false, isPlainText,
      });
      await getSessionService()?.updateState(foundKey, nextState, { selectedUserId });

      if (nextState === SessionState.PREVIEW) {
        await showPreview(ctx, foundKey);
      } else {
        // Show custom text keyboard
        const keyboard = await createCustomTextKeyboard();
        await ctx.editMessageText('Do you want to add custom text to this post?', {
          reply_markup: keyboard,
        });
      }

      logger.debug(`Nickname "${nicknameSelection}" selected for message ${originalMessage.message_id}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Error processing nickname selection. Please try again.',
        'Error in nickname selection callback'
      );
    }
  });

  // Handle text handling selection
  bot.callbackQuery(/^text:(keep|remove|quote)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const match = ctx.callbackQuery?.data?.match(/^text:(keep|remove|quote)$/);
      const textHandling = match?.[1] as 'keep' | 'remove' | 'quote';

      if (!textHandling) {
        await ErrorMessages.invalidSelection(ctx, 'text handling option');
        return;
      }

      // Find the original message
      const originalMessage = ctx.callbackQuery?.message?.reply_to_message;

      if (!originalMessage) {
        await ErrorMessages.originalMessageNotFound(ctx);
        return;
      }

      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      const foundKey = session?._id.toString();

      if (!foundKey) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      const nextState = getNextState(SessionState.TEXT_HANDLING, {
        isGreenListed: false, isRedListed: false, hasText: true, isForward: false,
      });
      await getSessionService()?.updateState(foundKey, nextState, { textHandling });

      // After text handling, try auto-selecting nickname or show selection keyboard
      await handleNicknameSelection(ctx, originalMessage, foundKey);

      logger.debug(`Text handling "${textHandling}" selected for message ${originalMessage.message_id}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Error processing text handling. Please try again.',
        'Error in text handling callback'
      );
    }
  });

  bot.callbackQuery('action:quick', async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const originalMessage = ctx.callbackQuery?.message?.reply_to_message;
      if (!originalMessage) {
        await ErrorMessages.originalMessageNotFound(ctx);
        return;
      }

      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      const forwardInfo = parseForwardInfo(originalMessage);

      // Collapse transform + remove text + auto-nickname + skip custom text into one step
      await getSessionService()?.updateState(session._id.toString(), SessionState.PREVIEW, {
        selectedAction: 'transform',
        textHandling: 'remove',
        selectedUserId: forwardInfo.fromUserId ?? null,
      });

      await showPreview(ctx, session._id.toString());

      logger.debug(`Quick post selected for message ${originalMessage.message_id}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Error processing quick post. Please try again.',
        'Error in quick post callback'
      );
    }
  });

  bot.callbackQuery('action:transform', async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      // Find the original message from pending forwards
      const originalMessage = ctx.callbackQuery?.message?.reply_to_message;

      if (!originalMessage) {
        await ErrorMessages.originalMessageNotFound(ctx);
        return;
      }

      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);

      const content = extractMessageContent(originalMessage);
      const hasText = !!(content?.text && content.text.trim().length > 0);

      if (session) {
        const nextState = getNextState(SessionState.ACTION_SELECT, {
          isGreenListed: false, isRedListed: false, hasText, isForward: false,
        });
        await getSessionService()?.updateState(session._id.toString(), nextState, {
          selectedAction: 'transform',
        });
      }

      if (hasText) {
        await ctx.editMessageText('How should the text be handled?', {
          reply_markup: createTextHandlingKeyboard(),
        });
      } else {
        await handleNicknameSelection(ctx, originalMessage, session?._id.toString());
      }

      logger.debug(`Transform action selected for message ${originalMessage.message_id}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Error processing transform. Please try again.',
        'Error in transform callback'
      );
    }
  });

  bot.callbackQuery('action:forward', async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      // Find the original message
      const originalMessage = ctx.callbackQuery?.message?.reply_to_message;

      if (!originalMessage) {
        await ErrorMessages.originalMessageNotFound(ctx);
        return;
      }

      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      const foundKey = session?._id.toString();
      const { selectedChannel } = session ?? {};

      if (!foundKey) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      if (!selectedChannel) {
        await ErrorMessages.channelSelectionRequired(ctx);
        return;
      }

      await getSessionService()?.update(foundKey, { selectedAction: 'forward' });
      await showPreview(ctx, foundKey);

      logger.debug(`Forward action selected for message ${originalMessage.message_id}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Error scheduling post. Please try again.',
        'Error in forward callback'
      );
    }
  });

  // Handle preview schedule button
  bot.callbackQuery(/^preview:schedule:(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const match = ctx.callbackQuery?.data?.match(/^preview:schedule:(.+)$/);
      const sessionKey = match?.[1];

      if (!sessionKey) {
        await ctx.reply('Invalid session. Please try again.');
        return;
      }

      const sessionSvc = getSessionService();
      if (!sessionSvc) {
        await ctx.reply('Service unavailable. Please try again.');
        return;
      }

      const session = await sessionSvc.findById(sessionKey);
      if (!session) {
        await ctx.reply('Session expired. Please forward the message again.');
        return;
      }

      const fromId = ctx.from?.id;

      // ── Edit-session confirm ──────────────────────────────────────────────
      if (session.editingPostId) {
        const {
          editingPostId,
          editingOriginalChannelId,
          editingOriginalScheduledTime,
          editingRawContent,
          editingOriginalForward,
        } = session;

        const sameChannel = session.selectedChannel === editingOriginalChannelId;
        const repository = new ScheduledPostRepository();

        if (sameChannel) {
          let newContent = editingRawContent!;
          if (session.selectedAction === 'transform') {
            const selectedNickname = session.selectedUserId
              ? await findNicknameByUserId(session.selectedUserId)
              : null;
            const transformedText = await transformerService.transformMessage(
              editingRawContent!.text ?? '',
              editingOriginalForward!,
              'transform',
              session.textHandling ?? 'keep',
              selectedNickname,
              session.customText
            );
            newContent = { ...editingRawContent!, text: transformedText };
          }

          const updated = await repository.updatePost(editingPostId!, {
            content: newContent,
            action: session.selectedAction ?? 'transform',
            rawContent: editingRawContent!,
            textHandling: session.textHandling,
            selectedUserId: session.selectedUserId,
            customText: session.customText,
          });

          if (fromId) await deletePreviewMessages(ctx, fromId, session);
          await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
          await sessionSvc.complete(sessionKey);

          if (!updated) {
            await ctx.reply('⚠️ Post was already published — your changes were not applied.');
            return;
          }

          const channelDoc = await PostingChannel.findOne({ channelId: editingOriginalChannelId }).lean();
          const channelLabel = channelDoc?.channelTitle ?? channelDoc?.channelUsername ?? editingOriginalChannelId;
          await ctx.reply(
            `✅ Post updated!\nTarget: ${channelLabel}\nScheduled for: ${formatSlotTime(editingOriginalScheduledTime!)}`
          );
        } else {
          await queueService.deleteAndCascade(editingPostId!);

          const newChannelId = session.selectedChannel!;
          const { scheduledTime } =
            session.selectedAction === 'forward'
              ? await postScheduler.scheduleForwardPost({
                  targetChannelId: newChannelId,
                  forwardInfo: editingOriginalForward!,
                  content: editingRawContent!,
                })
              : await postScheduler.scheduleTransformPost({
                  targetChannelId: newChannelId,
                  forwardInfo: editingOriginalForward!,
                  content: editingRawContent!,
                  textHandling: session.textHandling ?? 'keep',
                  selectedUserId: session.selectedUserId,
                  customText: session.customText,
                });

          if (fromId) await deletePreviewMessages(ctx, fromId, session);
          await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
          await sessionSvc.complete(sessionKey);

          const channelDoc = await PostingChannel.findOne({ channelId: newChannelId }).lean();
          const channelLabel = channelDoc?.channelTitle ?? channelDoc?.channelUsername ?? newChannelId;
          await ctx.reply(
            `✅ Moved to ${channelLabel}\nScheduled for: ${formatSlotTime(scheduledTime)}`
          );
        }

        logger.info(`Edit confirmed for session ${sessionKey}`);
        return;
      }
      // ── End edit-session confirm ──────────────────────────────────────────

      const originalMessage = session.originalMessage!;
      const mediaGroupMessages = session.mediaGroupMessages;
      const selectedChannel = session.selectedChannel;

      if (!selectedChannel) {
        await ctx.reply('No channel selected.');
        return;
      }

      // Parse forward info
      const forwardInfo = parseForwardInfo(originalMessage);
      if (mediaGroupMessages && mediaGroupMessages.length > 1) {
        forwardInfo.mediaGroupMessageIds = mediaGroupMessages.map((msg) => msg.message_id);
      }
      // For reply chains, store all message IDs so the post worker forwards the full thread
      const replyChainMessagesForSchedule = session.replyChainMessages;
      if (replyChainMessagesForSchedule && replyChainMessagesForSchedule.length > 1) {
        forwardInfo.replyChainMessageIds = replyChainMessagesForSchedule.map((msg) => msg.message_id);
      }

      // Extract message content
      const content = extractMessageContent(originalMessage, mediaGroupMessages);
      if (!content) {
        await ctx.reply('Unsupported message type.');
        return;
      }

      const { textHandling = 'keep', selectedUserId, customText } = session;

      const baseParams = { targetChannelId: selectedChannel, originalMessage, forwardInfo, content };

      const { scheduledTime } = session.selectedAction === 'forward'
        ? await postScheduler.scheduleForwardPost(baseParams)
        : await postScheduler.scheduleTransformPost({ ...baseParams, textHandling, selectedUserId, customText });

      if (fromId) {
        await deletePreviewMessages(ctx, fromId, session);
      }

      await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));

      // Clean up session
      await sessionSvc.complete(sessionKey);

      const channelDoc = await PostingChannel.findOne({ channelId: selectedChannel }).lean();
      const channelLabel = channelDoc?.channelTitle ?? channelDoc?.channelUsername ?? selectedChannel;

      await ctx.reply(
        `Post scheduled!\nTarget: ${channelLabel}\nScheduled for: ${formatSlotTime(scheduledTime)}`
      );

      logger.info(`Post scheduled from preview for session ${sessionKey}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Failed to schedule post. Please try again.',
        'Error in preview:schedule callback'
      );
    }
  });

  // Handle preview cancel button
  bot.callbackQuery(/^preview:cancel:(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const match = ctx.callbackQuery?.data?.match(/^preview:cancel:(.+)$/);
      const sessionKey = match?.[1];

      if (!sessionKey) {
        await ctx.reply('Invalid session.');
        return;
      }

      const sessionSvc = getSessionService();
      if (!sessionSvc) {
        await ctx.reply('Service unavailable.');
        return;
      }

      const session = await sessionSvc.findById(sessionKey);
      if (!session) {
        await ctx.reply('Session already expired or cancelled.');
        return;
      }

      const fromId = ctx.from?.id;
      if (fromId) {
        await deletePreviewMessages(ctx, fromId, session);
      }

      await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));

      // Edit sessions: original post stays untouched
      if (session.editingPostId) {
        await sessionSvc.complete(sessionKey);
        await ctx.reply('Edit cancelled.');
        logger.info(`Edit cancelled for session ${sessionKey}`);
        return;
      }

      await sessionSvc.complete(sessionKey);

      await ctx.reply('Cancelled. Forward a new message to start over.');

      logger.info(`Preview cancelled for session ${sessionKey}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Error cancelling preview.',
        'Error in preview:cancel callback'
      );
    }
  });

  // Handle preview back button — returns to channel selection
  bot.callbackQuery(/^preview:back:(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const match = ctx.callbackQuery?.data?.match(/^preview:back:(.+)$/);
      const sessionKey = match?.[1];

      if (!sessionKey) {
        await ctx.reply('Invalid session.');
        return;
      }

      const sessionSvc = getSessionService();
      if (!sessionSvc) {
        await ctx.reply('Service unavailable.');
        return;
      }

      const session = await sessionSvc.findById(sessionKey);
      if (!session) {
        await ctx.reply('Session already expired or cancelled.');
        return;
      }

      const fromId = ctx.from?.id;
      if (fromId) {
        await deletePreviewMessages(ctx, fromId, session);
      }

      // Delete the control message (this message with the keyboard)
      await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));

      // Edit sessions: re-send channel selection
      if (session.editingPostId) {
        await sessionSvc.updateState(sessionKey, SessionState.CHANNEL_SELECT, {
          selectedChannel: session.editingOriginalChannelId,
          selectedAction: undefined,
          textHandling: undefined,
          selectedUserId: undefined,
          customText: undefined,
          previewMessageId: undefined,
          previewMessageIds: undefined,
        });

        const channels = await getActivePostingChannels();
        if (channels.length === 0) {
          await ctx.reply('⚠️ No posting channels configured.');
          return;
        }
        if (!fromId) return;
        const keyboard = createEditChannelSelectKeyboard(channels, sessionKey);
        await ctx.api.sendMessage(fromId, '📍 Select target channel:', {
          reply_markup: keyboard as any,
        });

        logger.info(`Edit back: re-showing channel select for session ${sessionKey}`);
        return;
      }

      // Reset session back to channel selection state
      await sessionSvc.updateState(sessionKey, SessionState.CHANNEL_SELECT, {
        selectedChannel: undefined,
        selectedAction: undefined,
        selectedUserId: undefined,
        textHandling: undefined,
        customText: undefined,
        previewMessageId: undefined,
        previewMessageIds: undefined,
      });

      // Re-send channel selection keyboard
      const postingChannels = await getActivePostingChannels();
      if (postingChannels.length === 0) {
        await ctx.reply('⚠️ No posting channels configured.');
        return;
      }

      const channels = postingChannels.map((ch) => ({
        id: ch.channelId,
        title: ch.channelTitle ?? ch.channelId,
        username: ch.channelUsername,
      }));

      await ctx.api.sendMessage(
        session.originalMessage!.chat.id,
        '📍 Select target channel:',
        {
          reply_markup: createChannelSelectKeyboard(channels),
          reply_to_message_id: session.originalMessage!.message_id,
        }
      );

      logger.info(`Preview back for session ${sessionKey}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Error going back.',
        'Error in preview:back callback'
      );
    }
  });

}
