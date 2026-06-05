// src/bot/handlers/callbacks/scheduling.ts
import { Context } from 'grammy';
import { bot } from '../../bot.js';
import { parseForwardInfo } from '../../../utils/message-parser.js';
import { transformerService } from '../../../services/transformer.service.js';
import { extractMessageContent } from '../forward.handler.js';
import { createForwardActionKeyboard } from '../../keyboards/forward-action.keyboard.js';
import { createChannelSelectKeyboard } from '../../keyboards/channel-select.keyboard.js';
import { createEditChannelSelectKeyboard } from '../../keyboards/edit-keyboards.js';
import { createReplySlotKeyboard } from '../../keyboards/reply-slot.keyboard.js';
import { createAddReplyKeyboard } from '../../keyboards/preview-action.keyboard.js';
import type { EmbeddedReplyData } from '../../../database/models/scheduled-post.model.js';
import { CustomTextPreset } from '../../../database/models/custom-text-preset.model.js';
import { formatSlotTime } from '../../../utils/time-slots.js';
import { logger } from '../../../utils/logger.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { NICKNAME_NONE_KEY } from '../../keyboards/nickname-select.keyboard.js';
import { findNicknameByUserId } from '../../../shared/helpers/nickname.helper.js';
import { PostSchedulerService } from '../../../core/posting/post-scheduler.service.js';
import { SessionState } from '../../../shared/constants/flow-states.js';
import type { FlowEvent } from '../../../shared/constants/flow-states.js';
import { transition } from '../../../core/session/session-state-machine.js';
import { PostingChannel, getActivePostingChannels } from '../../../database/models/posting-channel.model.js';
import { ScheduledPostRepository } from '../../../database/repositories/scheduled-post.repository.js';
import { QueueService } from '../../../core/queue/queue.service.js';
import type { ISession } from '../../../database/models/session.model.js';
import {
  getSessionService,
  deletePreviewMessages,
  showPreview,
  renderStep,
  computeIsPlainText,
  resolveKnownNicknameUserId,
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

      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      const sessionSvc = getSessionService();

      // Reply sessions: advance to REPLY_SLOT_CHOICE and show slot keyboard
      if (session && sessionSvc && session.isReply) {
        await sessionSvc.updateState(session._id.toString(), SessionState.REPLY_SLOT_CHOICE, {
          selectedChannel: selectedChannelId,
        });
        const slotKeyboard = createReplySlotKeyboard(session._id.toString());
        await ctx.editMessageText('When should this reply be sent?', { reply_markup: slotKeyboard });
        return;
      }

      const isPoll = content?.type === 'poll';

      if (!session || !sessionSvc) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      const event: FlowEvent = {
        type: 'CHANNEL_SELECTED',
        channelId: selectedChannelId,
        isGreenListed: shouldAutoForward,
        isPoll,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await sessionSvc.updateState(session._id.toString(), newState, sessionUpdates);
      await renderStep(ctx, step, session._id.toString());

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
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }
      const foundKey = session._id.toString();

      if (action === 'add') {
        // Self-loop: stays in CUSTOM_TEXT, waiting for the user's reply with the text
        await getSessionService().updateState(foundKey, SessionState.CUSTOM_TEXT, { waitingForCustomText: true });
        await ctx.editMessageText(
          '✍️ Reply to this message with your custom text.\n\n' +
            'This text will be added at the beginning of your post.'
        );
        logger.debug(`Custom text reply prompt shown for message ${originalMessage.message_id}`);
        return;
      }

      const event: FlowEvent = {
        type: 'CUSTOM_TEXT_SELECTED',
        text: undefined,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(foundKey, newState, sessionUpdates);
      await renderStep(ctx, step, foundKey);

      logger.debug(`Custom text skipped for message ${originalMessage.message_id}`);
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
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }
      const foundKey = session._id.toString();

      const event: FlowEvent = {
        type: 'CUSTOM_TEXT_SELECTED',
        text: preset.text,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(foundKey, newState, sessionUpdates);
      await renderStep(ctx, step, foundKey);

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

      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }
      const foundKey = session._id.toString();

      const selectedUserId = nicknameSelection === NICKNAME_NONE_KEY ? null : parseInt(nicknameSelection, 10);
      const fullMessage = session.originalMessage ?? originalMessage;
      const isPlainText = computeIsPlainText(fullMessage);

      const event: FlowEvent = {
        type: 'NICKNAME_SELECTED',
        userId: selectedUserId,
        isPlainText,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(foundKey, newState, sessionUpdates);
      await renderStep(ctx, step, foundKey);

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
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }
      const foundKey = session._id.toString();

      const fullMessage = session.originalMessage ?? originalMessage;
      const isPlainText = computeIsPlainText(fullMessage);
      const knownNicknameUserId = await resolveKnownNicknameUserId(parseForwardInfo(fullMessage));

      const event: FlowEvent = {
        type: 'TEXT_HANDLING_SELECTED',
        handling: textHandling,
        isPlainText,
        knownNicknameUserId,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(foundKey, newState, sessionUpdates);
      await renderStep(ctx, step, foundKey);

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

      const event: FlowEvent = {
        type: 'ACTION_SELECTED',
        action: 'quick',
        hasText: false,
        hasBlockquotes: false,
        isPlainText: false,
        fromUserId: forwardInfo.fromUserId,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(session._id.toString(), newState, sessionUpdates);
      await renderStep(ctx, step, session._id.toString());

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
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      const content = extractMessageContent(originalMessage);
      const hasText = !!(content?.text?.trim());
      const hasBlockquotes = hasText && (content?.text?.includes('<blockquote>') ?? false);
      const fullMessage = session.originalMessage ?? originalMessage;
      const isPlainText = computeIsPlainText(fullMessage);
      const forwardInfo = parseForwardInfo(fullMessage);
      const knownNicknameUserId = await resolveKnownNicknameUserId(forwardInfo);

      const event: FlowEvent = {
        type: 'ACTION_SELECTED',
        action: 'transform',
        hasText,
        hasBlockquotes,
        isPlainText,
        fromUserId: forwardInfo.fromUserId,
        knownNicknameUserId,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(session._id.toString(), newState, sessionUpdates);
      await renderStep(ctx, step, session._id.toString());

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
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      if (!session.selectedChannel) {
        await ErrorMessages.channelSelectionRequired(ctx);
        return;
      }

      const event: FlowEvent = {
        type: 'ACTION_SELECTED',
        action: 'forward',
        // The forward edge fires unconditionally on action='forward'; these fields are unused by its guard
        hasText: false,
        hasBlockquotes: false,
        isPlainText: false,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(session._id.toString(), newState, sessionUpdates);
      await renderStep(ctx, step, session._id.toString());

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

        if (!editingPostId || !editingRawContent || !editingOriginalForward || !editingOriginalScheduledTime || !editingOriginalChannelId) {
          await ctx.reply('❌ Edit session is corrupted. Please start over.');
          return;
        }

        const sameChannel = session.selectedChannel === editingOriginalChannelId;
        const repository = new ScheduledPostRepository();

        if (sameChannel) {
          let newContent = editingRawContent;
          if (session.selectedAction === 'transform') {
            const selectedNickname = session.selectedUserId
              ? await findNicknameByUserId(session.selectedUserId)
              : null;
            const transformedText = await transformerService.transformMessage(
              editingRawContent.text ?? '',
              editingOriginalForward,
              'transform',
              session.textHandling ?? 'keep',
              selectedNickname,
              session.customText
            );
            newContent = { ...editingRawContent, text: transformedText };
          }

          const updated = await repository.updatePost(editingPostId, {
            content: newContent,
            action: session.selectedAction ?? 'transform',
            rawContent: editingRawContent,
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
            `✅ Post updated!\nTarget: ${channelLabel}\nScheduled for: ${formatSlotTime(editingOriginalScheduledTime)}`
          );
        } else {
          await queueService.deleteAndCascade(editingPostId);

          const newChannelId = session.selectedChannel ?? editingOriginalChannelId;
          const { scheduledTime } =
            session.selectedAction === 'forward'
              ? await postScheduler.scheduleForwardPost({
                  targetChannelId: newChannelId,
                  forwardInfo: editingOriginalForward,
                  content: editingRawContent,
                })
              : await postScheduler.scheduleTransformPost({
                  targetChannelId: newChannelId,
                  forwardInfo: editingOriginalForward,
                  content: editingRawContent,
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

      // ── Reply-session confirm ──────────────────────────────────────────────
      if (session.isReply && session.replyParentPostId) {
        const replyOriginalMessage = session.originalMessage;
        if (!replyOriginalMessage) {
          await ctx.reply('Reply session is corrupted. Please start over.');
          return;
        }

        const replySelectedChannel = session.selectedChannel;
        if (!replySelectedChannel) {
          await ctx.reply('No channel selected for reply.');
          return;
        }

        const repository = new ScheduledPostRepository();
        const parentPost = await repository.findById(session.replyParentPostId);

        const replyForwardInfo = parseForwardInfo(replyOriginalMessage);
        const replyMediaGroupMessages = session.mediaGroupMessages;
        if (replyMediaGroupMessages && replyMediaGroupMessages.length > 1) {
          replyForwardInfo.mediaGroupMessageIds = replyMediaGroupMessages.map((m) => m.message_id);
        }

        const replyContent = extractMessageContent(replyOriginalMessage, replyMediaGroupMessages);
        if (!replyContent) {
          await ctx.reply('Unsupported reply content type.');
          return;
        }

        const {
          textHandling: replyTextHandling = 'keep',
          selectedUserId: replyUserId,
          customText: replyCustomText,
          selectedAction: replyAction = 'transform',
        } = session;

        if (session.replyMode === 'together') {
          const replyNickname = replyUserId ? await findNicknameByUserId(replyUserId) : null;
          const replyText =
            replyAction === 'transform'
              ? await transformerService.transformMessage(
                  replyContent.text ?? '',
                  replyForwardInfo,
                  'transform',
                  replyTextHandling,
                  replyNickname,
                  replyCustomText
                )
              : replyContent.text ?? '';

          const transformedReplyContent = { ...replyContent, text: replyText };

          const replyData: EmbeddedReplyData = {
            targetChannelId: replySelectedChannel,
            content: transformedReplyContent,
            rawContent: replyContent,
            action: replyAction,
            textHandling: replyTextHandling,
            selectedUserId: replyUserId ?? null,
            customText: replyCustomText,
            originalForward: replyForwardInfo,
          };

          const attached = await repository.attachEmbeddedReply(session.replyParentPostId, replyData);

          if (fromId) await deletePreviewMessages(ctx, fromId, session);
          await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
          await sessionSvc.complete(sessionKey);

          if (!attached) {
            await ctx.reply('⚠️ Parent post was already published — reply could not be attached.');
            return;
          }

          const parentSlotTime = parentPost?.scheduledTime;
          await ctx.reply(
            `↩️ Reply scheduled with the parent post${parentSlotTime ? ` at ${formatSlotTime(parentSlotTime)}` : ''}`
          );
          logger.info(`Together reply attached to parent post ${session.replyParentPostId}`);
          return;
        }

        // Separated reply: schedule normally, then convert to separated reply
        const baseReplyParams = {
          targetChannelId: replySelectedChannel,
          originalMessage: replyOriginalMessage,
          forwardInfo: replyForwardInfo,
          content: replyContent,
        };

        const { scheduledTime: replySlotTime, postId: replyPostId } =
          replyAction === 'forward'
            ? await postScheduler.scheduleForwardPost(baseReplyParams)
            : await postScheduler.scheduleTransformPost({
                ...baseReplyParams,
                textHandling: replyTextHandling,
                selectedUserId: replyUserId,
                customText: replyCustomText,
              });

        await repository.convertToSeparatedReply(replyPostId, session.replyParentPostId, parentPost ?? null);

        if (fromId) await deletePreviewMessages(ctx, fromId, session);
        await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
        await sessionSvc.complete(sessionKey);

        await ctx.reply(`↩️ Reply scheduled for ${formatSlotTime(replySlotTime)}`);
        logger.info(`Separated reply scheduled at ${formatSlotTime(replySlotTime)}, post ${replyPostId}`);
        return;
      }
      // ── End reply-session confirm ──────────────────────────────────────────

      const originalMessage = session.originalMessage;
      if (!originalMessage) {
        await ctx.reply('Session is corrupted. Please forward the message again.');
        return;
      }
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

      const { scheduledTime, postId } = session.selectedAction === 'forward'
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
        `Post scheduled!\nTarget: ${channelLabel}\nScheduled for: ${formatSlotTime(scheduledTime)}`,
        { reply_markup: createAddReplyKeyboard(postId) }
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
          reply_markup: keyboard,
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

      const origMsg = session.originalMessage;
      if (!origMsg) return;

      await ctx.api.sendMessage(
        origMsg.chat.id,
        '📍 Select target channel:',
        {
          reply_markup: createChannelSelectKeyboard(channels),
          reply_to_message_id: origMsg.message_id,
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

  // Handle reply slot choice: together (same cycle as parent) or separated (own slot)
  bot.callbackQuery(/^reply_slot:(together|separated):(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const match = ctx.callbackQuery?.data?.match(/^reply_slot:(together|separated):(.+)$/);
      const mode = match?.[1] as 'together' | 'separated';
      const sessionId = match?.[2];

      if (!mode || !sessionId) {
        await ctx.editMessageText('❌ Invalid reply slot selection.');
        return;
      }

      const sessionSvc = getSessionService();
      const session = await sessionSvc.findById(sessionId);
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      await sessionSvc.updateState(sessionId, SessionState.ACTION_SELECT, { replyMode: mode });

      // Check for green-listed source — auto-forward if applicable
      const originalMessage = session.originalMessage;
      if (originalMessage) {
        const forwardInfo = parseForwardInfo(originalMessage);
        const shouldAutoForward = await transformerService.shouldAutoForward(forwardInfo);

        if (shouldAutoForward) {
          await sessionSvc.update(sessionId, { selectedAction: 'forward' });
          await showPreview(ctx, sessionId);
          return;
        }

        const content = extractMessageContent(originalMessage);
        if (content?.type === 'poll') {
          await sessionSvc.update(sessionId, { selectedAction: 'forward' });
          await showPreview(ctx, sessionId);
          return;
        }
      }

      const keyboard = createForwardActionKeyboard();
      await ctx.editMessageText(
        'Choose how to post this reply:\n⚡ <b>Quick post</b> — transform, no attribution, no extra text',
        { reply_markup: keyboard, parse_mode: 'HTML' }
      );

      logger.debug(`Reply slot mode "${mode}" set for session ${sessionId}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Error processing reply slot selection. Please try again.',
        'Error in reply_slot callback'
      );
    }
  });

}
