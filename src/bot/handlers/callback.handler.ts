import { Context } from 'grammy';
import { Message } from 'grammy/types';
import { extractMessageContent } from './forward.handler.js';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { transformerService } from '../../services/transformer.service.js';
import { createForwardActionKeyboard } from '../keyboards/forward-action.keyboard.js';
import { createTextHandlingKeyboard } from '../keyboards/text-handling.keyboard.js';
import { createCustomTextKeyboard } from '../keyboards/custom-text.keyboard.js';
import { CustomTextPreset } from '../../database/models/custom-text-preset.model.js';
import { formatSlotTime } from '../../utils/time-slots.js';
import { logger } from '../../utils/logger.js';
import { bot } from '../bot.js';
import { ErrorMessages } from '../../shared/constants/error-messages.js';
import {
  findNicknameByUserId,
  getNicknameKeyboard,
  parseNicknameSelection,
} from '../../shared/helpers/nickname.helper.js';
import { PostSchedulerService } from '../../core/posting/post-scheduler.service.js';
import { DIContainer } from '../../shared/di/container.js';
import type { SessionService } from '../../core/session/session.service.js';
import type { ISession } from '../../database/models/session.model.js';
import { SessionState } from '../../shared/constants/flow-states.js';
import { getNextState } from '../../core/session/session-state-machine.js';
import { PreviewGeneratorService } from '../../core/preview/preview-generator.service.js';
import { PreviewSenderService } from '../../core/preview/preview-sender.service.js';
import { QueueService } from '../../core/queue/queue.service.js';
import { QueuePreviewSenderService } from '../../core/queue/queue-preview-sender.service.js';
import { createQueueChannelSelectKeyboard } from '../keyboards/queue-channel-select.keyboard.js';
import { createQueueListKeyboard } from '../keyboards/queue-list.keyboard.js';
import { getActivePostingChannels } from '../../database/models/posting-channel.model.js';
import { createChannelSelectKeyboard } from '../keyboards/channel-select.keyboard.js';
import { ScheduledPostRepository } from '../../database/repositories/scheduled-post.repository.js';
import { InlineKeyboard } from 'grammy';
import { getSleepWindow } from '../../utils/sleep-window.js';
import { BotSettings } from '../../database/models/bot-settings.model.js';
import {
  createSleepStatusKeyboard,
  createHourPickerKeyboard,
  createSleepConfirmKeyboard,
} from '../keyboards/sleep.keyboard.js';

const postScheduler = new PostSchedulerService();
const queueService = new QueueService();

interface QueuePreviewState {
  previewMessageIds: number[];
  queueMessageId: number;
  channelId: string;
  page: number;
}
const queuePreviewStateMap = new Map<number, QueuePreviewState>();

// Get SessionService from DI container (will be initialized in index.ts)
let sessionService: SessionService;
const getSessionService = () => {
  if (!sessionService && DIContainer.has('SessionService')) {
    sessionService = DIContainer.resolve<SessionService>('SessionService');
  }
  return sessionService;
};

/**
 * Handle nickname selection - either auto-select if user has nickname, or show keyboard
 * Returns true if handled (auto-selected), false if keyboard shown
 */
async function handleNicknameSelection(
  ctx: Context,
  originalMessage: Message,
  sessionId?: string,
  isPlainText?: boolean
): Promise<boolean> {
  // Check if message is from a user with a known nickname
  const forwardInfo = parseForwardInfo(originalMessage);
  const fromUserId = forwardInfo?.fromUserId;

  if (fromUserId) {
    // Look up nickname for this user
    const nickname = await findNicknameByUserId(fromUserId);

    if (nickname) {
      logger.debug(`Auto-selecting nickname "${nickname}" for user ${fromUserId}`);

      const sessionSvc = getSessionService();
      if (sessionId && sessionSvc) {
        await sessionSvc.update(sessionId, { selectedNickname: nickname });
      }

      if (isPlainText && sessionId) {
        // Plain text message: skip custom text, go straight to preview
        await showPreview(ctx, sessionId);
      } else {
        const keyboard = await createCustomTextKeyboard();
        await ctx.editMessageText('Do you want to add custom text to this post?', {
          reply_markup: keyboard,
        });
      }

      return true; // Handled
    }
  }

  // No nickname found - show selection keyboard
  const keyboard = await getNicknameKeyboard();
  await ctx.editMessageText('Who should be credited for this post?', {
    reply_markup: keyboard,
  });

  return false; // Not handled, keyboard shown
}

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

async function renderQueuePage(
  ctx: Context,
  channelId: string,
  page: number,
  messageId?: number
): Promise<void> {
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
      await ctx.api.editMessageText(ctx.chat!.id, messageId, text, { reply_markup: keyboard });
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
    await ctx.api.editMessageText(ctx.chat!.id, messageId, text, { reply_markup: keyboard });
  } else {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  }
}

// Handle channel selection
bot.callbackQuery(/^select_channel:(.+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();

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

    // Parse forward info to check if it's green-listed or red-listed
    const forwardInfo = parseForwardInfo(originalMessage);
    const shouldAutoForward = await transformerService.shouldAutoForward(forwardInfo);

    // Check if red-listed
    const isRedListed = forwardInfo?.fromChannelId
      ? await transformerService.isRedListed(String(forwardInfo.fromChannelId))
      : false;

    // Check if message has text
    const content = extractMessageContent(originalMessage);
    const hasText = !!(content?.text && content.text.trim().length > 0);

    // DUAL READ: Try to find session in DB first, fall back to Map
    const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
    const foundKey = session?._id.toString();

    // Check for reply chain BEFORE state machine transition.
    // Reply chains always go directly to preview (action selection is skipped).
    // Checking here avoids writing a transient ACTION_SELECT state to the DB.
    const hasReplyChain = (session?.replyChainMessages?.length ?? 0) > 1;
    logger.info(`[RC-DEBUG] channel select: sessionFound=${!!session}, replyChainLen=${session?.replyChainMessages?.length}, hasReplyChain=${hasReplyChain}`);

    if (hasReplyChain && session) {
      const sessionSvc = getSessionService();
      if (sessionSvc) {
        await sessionSvc.update(session._id.toString(), { selectedChannel: selectedChannelId });
        logger.debug(`Reply chain detected, skipping action selection for session ${session._id}`);
        await showPreview(ctx, session._id.toString());
        return;
      }
    }

    // When the user sent their own reply to a cross-chat message (replyParameters set,
    // no forward_origin so fromChannelId/fromUserId are unset), the content is already
    // exactly what they want to post — skip transform/text/nickname steps entirely.
    const isOwnReply = !!forwardInfo.replyParameters && !forwardInfo.fromChannelId && !forwardInfo.fromUserId;
    if (isOwnReply && session) {
      const sessionSvc = getSessionService();
      if (sessionSvc) {
        await sessionSvc.update(session._id.toString(), {
          selectedChannel: selectedChannelId,
          selectedAction: 'transform',
          textHandling: 'keep',
          selectedNickname: null,
        });
        await showPreview(ctx, session._id.toString());
        return;
      }
    }

    const sessionSvc = getSessionService();
    if (session && sessionSvc) {
      const nextState = getNextState(SessionState.CHANNEL_SELECT, {
        isGreenListed: shouldAutoForward,
        isRedListed,
        hasText,
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

    // Red-listed channels auto-transform without asking
    if (isRedListed) {
      if (session && sessionSvc) {
        await sessionSvc.update(session._id.toString(), { selectedAction: 'transform' });
      }
      if (hasText) {
        await ctx.editMessageText('How should the text be handled?', {
          reply_markup: createTextHandlingKeyboard(),
        });
      } else {
        await handleNicknameSelection(ctx, originalMessage, session?._id.toString());
      }
      logger.debug(`Red-listed channel - auto-transforming message ${originalMessage.message_id}`);
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

    // Neither green nor red listed
    const isForwarded = !!originalMessage.forward_origin;

    if (!isForwarded) {
      // Non-forwarded message: forward option makes no sense, auto-select transform
      // Plain text (no media, no external reply): skip text handling (always keep) and custom text
      const isPlainText =
        content?.type === 'text' && !originalMessage.external_reply;
      if (session && sessionSvc) {
        const nextState = getNextState(SessionState.ACTION_SELECT, {
          isGreenListed: false,
          isRedListed: false,
          hasText,
          isForward: false,
          isPlainText,
        });
        await sessionSvc.updateState(session._id.toString(), nextState, {
          selectedAction: 'transform',
          ...(isPlainText ? { textHandling: 'keep' } : {}),
        });
      }
      if (isPlainText) {
        await handleNicknameSelection(ctx, originalMessage, session?._id.toString(), true);
      } else if (hasText) {
        await ctx.editMessageText('How should the text be handled?', {
          reply_markup: createTextHandlingKeyboard(),
        });
      } else {
        await handleNicknameSelection(ctx, originalMessage, session?._id.toString());
      }
      logger.debug(`Non-forwarded message ${originalMessage.message_id}: auto-selected transform`);
      return;
    }

    // Forwarded message - show transform/forward options
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
    await ctx.answerCallbackQuery();

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
    await ctx.answerCallbackQuery();

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

// Helper to delete all preview messages for a session
async function deletePreviewMessages(ctx: Context, fromId: number, session: { previewMessageIds?: number[]; previewMessageId?: number }) {
  const messageIds = (session.previewMessageIds?.length ?? 0) > 0
    ? (session.previewMessageIds ?? [])
    : session.previewMessageId
      ? [session.previewMessageId]
      : [];

  await Promise.all(
    messageIds.map(async (msgId) =>
      await ctx.api.deleteMessage(fromId, msgId).catch((err) =>
        logger.warn(`Failed to delete preview message ${msgId}:`, err)
      )
    )
  );
}

// Helper function to show preview
async function showPreview(ctx: Context, sessionKey: string) {
  try {
    const fromId = ctx.from?.id;
    if (!fromId) return;

    const sessionSvc = getSessionService();
    if (!sessionSvc) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    const session = await sessionSvc.findById(sessionKey);
    if (!session) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    // Generate preview content
    const previewGenerator = new PreviewGeneratorService();
    const previewContent = await previewGenerator.generatePreview(session);

    // Send preview to user's chat
    const previewSender = new PreviewSenderService(ctx.api);
    const previewMessageId = await previewSender.sendPreview(fromId, previewContent, sessionKey);

    // Update session with preview message ID and transition to PREVIEW state
    await sessionSvc.updateState(sessionKey, SessionState.PREVIEW, {
      previewMessageId,
    });

    // Delete the control message (the keyboard message that was edited through the flow)
    // so stale buttons don't remain after the session moves to preview.
    await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));

    logger.debug(`Preview shown for session ${sessionKey}`);
  } catch (error) {
    logger.error('Error showing preview:', error);
    await ctx.editMessageText('Preview generation failed. Please try again.');
  }
}

// Handle nickname selection
bot.callbackQuery(/^select_nickname:(.+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();

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

    // Parse nickname selection
    const selectedNickname = await parseNicknameSelection(nicknameSelection);

    const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
    const foundKey = session?._id.toString();

    if (!foundKey) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    const isPlainText =
      originalMessage.text !== undefined &&
      !('photo' in originalMessage && originalMessage.photo) &&
      !('video' in originalMessage && originalMessage.video) &&
      !('document' in originalMessage && originalMessage.document) &&
      !('animation' in originalMessage && originalMessage.animation) &&
      !('external_reply' in originalMessage && originalMessage.external_reply) &&
      !originalMessage.forward_origin;

    const nextState = getNextState(SessionState.NICKNAME_SELECT, {
      isGreenListed: false, isRedListed: false, hasText: false, isForward: false, isPlainText,
    });
    await getSessionService()?.updateState(foundKey, nextState, { selectedNickname });

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
    await ctx.answerCallbackQuery();

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
    await ctx.answerCallbackQuery();

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

    // Auto-apply nickname if the forwarded user is in the nickname list
    const forwardInfo = parseForwardInfo(originalMessage);
    const selectedNickname = forwardInfo.fromUserId
      ? await findNicknameByUserId(forwardInfo.fromUserId) ?? null
      : null;

    // Collapse transform + remove text + auto-nickname + skip custom text into one step
    await getSessionService()?.updateState(session._id.toString(), SessionState.PREVIEW, {
      selectedAction: 'transform',
      textHandling: 'remove',
      selectedNickname,
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
    await ctx.answerCallbackQuery();

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
    await ctx.answerCallbackQuery();

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
    await ctx.answerCallbackQuery();

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

    const originalMessage = session.originalMessage;
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
    logger.info(`[RC-DEBUG] preview:schedule replyChain: len=${replyChainMessagesForSchedule?.length}, ids=[${replyChainMessagesForSchedule?.map((msg) => msg.message_id).join(',')}]`);
    if (replyChainMessagesForSchedule && replyChainMessagesForSchedule.length > 1) {
      forwardInfo.replyChainMessageIds = replyChainMessagesForSchedule.map((msg) => msg.message_id);
      logger.info(`[RC-DEBUG] preview:schedule: set replyChainMessageIds=[${forwardInfo.replyChainMessageIds.join(',')}]`);
    }

    // Extract message content
    const content = extractMessageContent(originalMessage, mediaGroupMessages);
    if (!content) {
      await ctx.reply('Unsupported message type.');
      return;
    }

    const { textHandling = 'keep', selectedNickname, customText } = session;

    const baseParams = { targetChannelId: selectedChannel, originalMessage, forwardInfo, content };

    const { scheduledTime } = session.selectedAction === 'forward'
      ? await postScheduler.scheduleForwardPost(baseParams)
      : await postScheduler.scheduleTransformPost({ ...baseParams, textHandling, selectedNickname, customText });

    const fromId = ctx.from?.id;
    if (fromId) {
      await deletePreviewMessages(ctx, fromId, session);
    }

    await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));

    // Clean up session
    await sessionSvc.complete(sessionKey);

    await ctx.reply(
      `Post scheduled!\nTarget: ${selectedChannel}\nScheduled for: ${formatSlotTime(scheduledTime)}`
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
    await ctx.answerCallbackQuery();

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
    await ctx.answerCallbackQuery();

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

    // Reset session back to channel selection state
    await sessionSvc.updateState(sessionKey, SessionState.CHANNEL_SELECT, {
      selectedChannel: undefined,
      selectedAction: undefined,
      selectedNickname: undefined,
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
      session.originalMessage.chat.id,
      '📍 Select target channel:',
      {
        reply_markup: createChannelSelectKeyboard(channels),
        reply_to_message_id: session.originalMessage.message_id,
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

// queue:noop — pagination label button, does nothing
bot.callbackQuery('queue:noop', async (ctx: Context) => {
  await ctx.answerCallbackQuery();
});

// queue:channels — back to channel selection screen
bot.callbackQuery('queue:channels', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
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
    await ctx.answerCallbackQuery();
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
    await ctx.answerCallbackQuery();
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
    await ctx.answerCallbackQuery();
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
    for (const msgId of previewMessageIds) {
      await ctx.api.deleteMessage(userId, msgId).catch((err) =>
        logger.warn(`Failed to delete preview message ${msgId}:`, err)
      );
    }
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
    await ctx.answerCallbackQuery();
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

    for (const msgId of previewMessageIds) {
      await ctx.api.deleteMessage(userId, msgId).catch((err) =>
        logger.warn(`Failed to delete preview message ${msgId}:`, err)
      );
    }

    await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error going back.', 'queue:back callback');
  }
});

// ──────────────────────────────────────────────
// Sleep window configuration callbacks
// ──────────────────────────────────────────────

async function showSleepStatus(ctx: Context): Promise<void> {
  const sleepWindow = await getSleepWindow();
  const enabled = sleepWindow !== null;

  let text: string;
  if (enabled) {
    const startStr = sleepWindow.startHour.toString().padStart(2, '0');
    const endStr = sleepWindow.endHour.toString().padStart(2, '0');
    text = `Sleep hours: ${startStr}:00 – ${endStr}:00 ✅\nPosts scheduled during this window will be pushed to after ${endStr}:00.`;
  } else {
    text = 'Sleep hours: disabled';
  }

  await ctx.editMessageText(text, { reply_markup: createSleepStatusKeyboard(enabled) });
}

async function saveSleepSettings(
  enabled: boolean,
  startHour?: number,
  endHour?: number
): Promise<void> {
  const ops: Promise<unknown>[] = [
    BotSettings.findOneAndUpdate(
      { key: 'sleep_enabled' },
      { key: 'sleep_enabled', value: String(enabled), updatedAt: new Date() },
      { upsert: true }
    ),
  ];
  if (startHour !== undefined && endHour !== undefined) {
    ops.push(
      BotSettings.findOneAndUpdate(
        { key: 'sleep_start' },
        { key: 'sleep_start', value: String(startHour), updatedAt: new Date() },
        { upsert: true }
      ),
      BotSettings.findOneAndUpdate(
        { key: 'sleep_end' },
        { key: 'sleep_end', value: String(endHour), updatedAt: new Date() },
        { upsert: true }
      )
    );
  }
  await Promise.all(ops);
}

// sleep:enable — show start hour picker
bot.callbackQuery('sleep:enable', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Select start hour:', {
      reply_markup: createHourPickerKeyboard('start'),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error showing hour picker. Please try again.',
      'sleep:enable callback'
    );
  }
});

// sleep:change — same as enable (show start hour picker)
bot.callbackQuery('sleep:change', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Select start hour:', {
      reply_markup: createHourPickerKeyboard('start'),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error showing hour picker. Please try again.',
      'sleep:change callback'
    );
  }
});

// sleep:disable — disable and show updated status
bot.callbackQuery('sleep:disable', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    await saveSleepSettings(false);
    await showSleepStatus(ctx);
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error disabling sleep hours. Please try again.',
      'sleep:disable callback'
    );
  }
});

// sleep:start:<h> — store start, show end picker
bot.callbackQuery(/^sleep:start:(\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const match = ctx.callbackQuery?.data?.match(/^sleep:start:(\d+)$/);
    const startHour = parseInt(match![1], 10);
    await ctx.editMessageText('Select end hour:', {
      reply_markup: createHourPickerKeyboard('end', startHour),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error showing hour picker. Please try again.',
      'sleep:start callback'
    );
  }
});

// sleep:end:<start>:<h> — show confirm screen
bot.callbackQuery(/^sleep:end:(\d+):(\d+)$/, async (ctx: Context) => {
  try {
    const match = ctx.callbackQuery?.data?.match(/^sleep:end:(\d+):(\d+)$/);
    const startHour = parseInt(match![1], 10);
    const endHour = parseInt(match![2], 10);

    if (endHour <= startHour) {
      await ctx.answerCallbackQuery({ text: 'End hour must be after start hour', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    const startStr = startHour.toString().padStart(2, '0');
    const endStr = endHour.toString().padStart(2, '0');
    await ctx.editMessageText(`Sleep hours: ${startStr}:00 – ${endStr}:00\n\nConfirm?`, {
      reply_markup: createSleepConfirmKeyboard(startHour, endHour),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error showing confirmation. Please try again.',
      'sleep:end callback'
    );
  }
});

// sleep:confirm:<start>:<end> — save and show status
bot.callbackQuery(/^sleep:confirm:(\d+):(\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const match = ctx.callbackQuery?.data?.match(/^sleep:confirm:(\d+):(\d+)$/);
    const startHour = parseInt(match![1], 10);
    const endHour = parseInt(match![2], 10);
    await saveSleepSettings(true, startHour, endHour);
    await showSleepStatus(ctx);
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error saving sleep hours. Please try again.',
      'sleep:confirm callback'
    );
  }
});

// sleep:cancel — discard changes, show current status
bot.callbackQuery('sleep:cancel', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    await showSleepStatus(ctx);
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error showing sleep status. Please try again.',
      'sleep:cancel callback'
    );
  }
});
