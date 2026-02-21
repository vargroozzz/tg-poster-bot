import { Context } from 'grammy';
import { Message } from 'grammy/types';
import { extractMessageContent, pendingForwards } from './forward.handler.js';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { transformerService } from '../../services/transformer.service.js';
import { createForwardActionKeyboard } from '../keyboards/forward-action.keyboard.js';
import { createTextHandlingKeyboard } from '../keyboards/text-handling.keyboard.js';
import { createCustomTextKeyboard } from '../keyboards/custom-text.keyboard.js';
import { formatSlotTime } from '../../utils/time-slots.js';
import { logger } from '../../utils/logger.js';
import { bot } from '../bot.js';
import { PendingForwardHelper, type PendingForward } from '../../shared/helpers/pending-forward-finder.js';
import { ErrorMessages } from '../../shared/constants/error-messages.js';
import { NicknameHelper } from '../../shared/helpers/nickname.helper.js';
import { PostSchedulerService } from '../../core/posting/post-scheduler.service.js';
import { DIContainer } from '../../shared/di/container.js';
import type { SessionService } from '../../core/session/session.service.js';
import type { ISession } from '../../database/models/session.model.js';
import { SessionState } from '../../shared/constants/flow-states.js';
import { SessionStateMachine } from '../../core/session/session-state-machine.js';
import { PreviewGeneratorService } from '../../core/preview/preview-generator.service.js';
import { PreviewSenderService } from '../../core/preview/preview-sender.service.js';

const postScheduler = new PostSchedulerService();

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
  sessionId?: string
): Promise<boolean> {
  // Check if message is from a user with a known nickname
  const forwardInfo = parseForwardInfo(originalMessage);
  const fromUserId = forwardInfo?.fromUserId;

  if (fromUserId) {
    // Look up nickname for this user
    const nickname = await NicknameHelper.findNicknameByUserId(fromUserId);

    if (nickname) {
      // Auto-select this nickname and proceed to custom text
      logger.debug(`Auto-selecting nickname "${nickname}" for user ${fromUserId}`);

      // Update session/pending with selected nickname
      const sessionSvc = getSessionService();
      if (sessionId && sessionSvc) {
        await sessionSvc.update(sessionId, { selectedNickname: nickname });
      }

      // Show custom text keyboard
      const keyboard = createCustomTextKeyboard();
      await ctx.editMessageText('Do you want to add custom text to this post?', {
        reply_markup: keyboard,
      });

      return true; // Handled
    }
  }

  // No nickname found - show selection keyboard
  const keyboard = await NicknameHelper.getNicknameKeyboard();
  await ctx.editMessageText('Who should be credited for this post?', {
    reply_markup: keyboard,
  });

  return false; // Not handled, keyboard shown
}

/**
 * Helper to get pending forward from either DB or Map (dual-read pattern)
 * Tries DB first for persistence, falls back to Map for compatibility
 */
async function getPendingForward(
  userId: number,
  messageId: number
): Promise<{ session?: ISession; pending?: [string, PendingForward] }> {
  const sessionSvc = getSessionService();

  // Try database first
  if (sessionSvc) {
    try {
      const session = await sessionSvc.findByMessage(userId, messageId);
      if (session) {
        logger.debug(`Found session in DB for message ${messageId}`);
        return { session };
      }
    } catch (error) {
      logger.error('Error fetching session from DB, falling back to Map:', error);
    }
  }

  // Fall back to Map
  const pending = PendingForwardHelper.findByMessageId(messageId, pendingForwards);
  if (pending) {
    logger.debug(`Found session in Map for message ${messageId}`);
    return { pending };
  }

  return {};
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
    const { session, pending } = await getPendingForward(
      ctx.from?.id ?? 0,
      originalMessage.message_id
    );

    let foundKey: string | undefined;

    // Check for reply chain BEFORE state machine transition.
    // Reply chains always go directly to preview (action selection is skipped).
    // Checking here avoids writing a transient ACTION_SELECT state to the DB.
    const replyChainMessages = session?.replyChainMessages ?? pending?.[1].replyChainMessages;
    const hasReplyChain = (replyChainMessages?.length ?? 0) > 1;

    if (hasReplyChain && session) {
      const sessionSvc = getSessionService();
      if (sessionSvc) {
        // Store selected channel without going through the state machine
        await sessionSvc.update(session._id.toString(), {
          selectedChannel: selectedChannelId,
        });
        logger.debug(`Reply chain detected, skipping action selection for session ${session._id}`);
        await showPreview(ctx, session._id.toString());
        return;
      }
    }

    if (session) {
      // Update session in DB with proper state transition
      const sessionSvc = getSessionService();
      if (sessionSvc) {
        // Determine next state based on ACTUAL context
        const context = {
          isGreenListed: shouldAutoForward,
          isRedListed,
          hasText,
          isForward: false,
        };

        const nextState = SessionStateMachine.getNextState(SessionState.CHANNEL_SELECT, context);

        await sessionSvc.updateState(session._id.toString(), nextState, {
          selectedChannel: selectedChannelId,
        });
        foundKey = session._id.toString();
      }
    } else if (pending) {
      // Update Map (legacy path)
      const [key, pendingData] = pending;
      pendingData.selectedChannel = selectedChannelId;
      foundKey = key;
    }

    if (!foundKey) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    if (shouldAutoForward) {
      // Get media group messages if available
      let mediaGroupMessages: Message[] | undefined;

      if (session) {
        mediaGroupMessages = session.mediaGroupMessages;
      } else if (pending) {
        mediaGroupMessages = pending[1].mediaGroupMessages;
      }

      // Auto-forward green-listed content
      const content = extractMessageContent(originalMessage, mediaGroupMessages);

      if (!content || !forwardInfo) {
        await ctx.editMessageText('❌ Could not process message.');
        return;
      }

      const result = await postScheduler.scheduleForwardPost({
        targetChannelId: selectedChannelId,
        originalMessage,
        forwardInfo,
        content,
      });

      await ctx.editMessageText(
        `✅ Auto-scheduled (green-listed channel)\n` +
          `📍 Target: ${selectedChannelId}\n` +
          `📅 Scheduled for: ${formatSlotTime(result.scheduledTime)}`
      );

      // Cleanup: Delete from both DB and Map
      if (session && getSessionService()) {
        await getSessionService().complete(session._id.toString());
      }
      if (pending) {
        pendingForwards.delete(pending[0]);
      }
      return;
    }

    // Red-listed channels auto-transform without asking
    if (isRedListed) {
      // Store that transform was chosen (state already updated above)
      if (session && getSessionService()) {
        // Just update the action field (state was already transitioned above)
        await getSessionService().update(session._id.toString(), {
          selectedAction: 'transform',
        });
      } else if (pending) {
        pending[1].selectedAction = 'transform';
      }

      // Auto-transform: proceed directly to text handling or nickname selection
      const content = extractMessageContent(originalMessage);
      const hasText = content?.text && content.text.trim().length > 0;

      if (hasText) {
        const keyboard = createTextHandlingKeyboard();
        await ctx.editMessageText('How should the text be handled?', {
          reply_markup: keyboard,
        });
      } else {
        // No text - try auto-selecting nickname or show selection keyboard
        const sessionId = session?._id.toString();
        await handleNicknameSelection(ctx, originalMessage, sessionId);
      }

      logger.debug(`Red-listed channel - auto-transforming message ${originalMessage.message_id}`);
      return;
    }

    // Neither green nor red listed - show transform/forward options
    const keyboard = createForwardActionKeyboard();
    await ctx.editMessageText('Choose how to post this message:', {
      reply_markup: keyboard,
    });

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

    // DUAL READ: Find session in DB or Map
    const { session, pending } = await getPendingForward(
      ctx.from?.id ?? 0,
      originalMessage.message_id
    );

    let foundKey: string | undefined;

    // Update based on action
    const updates = action === 'add'
      ? { waitingForCustomText: true }
      : { customText: undefined };

    if (session && getSessionService()) {
      // For custom text, we either wait for input or proceed to preview
      // Keep state as CUSTOM_TEXT while waiting, or transition to PREVIEW
      const nextState = action === 'add' ? SessionState.CUSTOM_TEXT : SessionState.PREVIEW;

      await getSessionService().updateState(session._id.toString(), nextState, updates);
      foundKey = session._id.toString();
    } else if (pending) {
      Object.assign(pending[1], updates);
      foundKey = pending[0];
    }

    if (!foundKey) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

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

// Helper function to show preview
async function showPreview(ctx: Context, sessionKey: string) {
  try {
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
    const previewMessageId = await previewSender.sendPreview(ctx.from!.id, previewContent, sessionKey);

    // Update session with preview message ID and transition to PREVIEW state
    await sessionSvc.updateState(sessionKey, SessionState.PREVIEW, {
      previewMessageId,
    });

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
    const selectedNickname = await NicknameHelper.parseNicknameSelection(nicknameSelection);

    // DUAL READ: Find and update session or pending forward
    const { session, pending } = await getPendingForward(
      ctx.from?.id ?? 0,
      originalMessage.message_id
    );

    let foundKey: string | undefined;

    if (session && getSessionService()) {
      // Transition from NICKNAME_SELECT to CUSTOM_TEXT
      const context = {
        isGreenListed: false,
        isRedListed: false,
        hasText: false,
        isForward: false,
      };

      const nextState = SessionStateMachine.getNextState(SessionState.NICKNAME_SELECT, context);

      await getSessionService().updateState(session._id.toString(), nextState, {
        selectedNickname,
      });
      foundKey = session._id.toString();
    } else if (pending) {
      pending[1].selectedNickname = selectedNickname;
      foundKey = pending[0];
    }

    if (!foundKey) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    // Show custom text keyboard
    const keyboard = createCustomTextKeyboard();

    await ctx.editMessageText('Do you want to add custom text to this post?', {
      reply_markup: keyboard,
    });

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

    // DUAL READ: Find and update session or pending forward
    const { session, pending } = await getPendingForward(
      ctx.from?.id ?? 0,
      originalMessage.message_id
    );

    let foundKey: string | undefined;

    if (session && getSessionService()) {
      // Transition from TEXT_HANDLING to NICKNAME_SELECT
      const context = {
        isGreenListed: false,
        isRedListed: false,
        hasText: true,
        isForward: false,
      };

      const nextState = SessionStateMachine.getNextState(SessionState.TEXT_HANDLING, context);

      await getSessionService().updateState(session._id.toString(), nextState, {
        textHandling,
      });
      foundKey = session._id.toString();
    } else if (pending) {
      pending[1].textHandling = textHandling;
      foundKey = pending[0];
    }

    if (!foundKey) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

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

bot.callbackQuery('action:transform', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();

    // Find the original message from pending forwards
    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;

    if (!originalMessage) {
      await ErrorMessages.originalMessageNotFound(ctx);
      return;
    }

    // DUAL READ: Find and update session or pending forward
    const { session, pending } = await getPendingForward(
      ctx.from?.id ?? 0,
      originalMessage.message_id
    );

    // Check if message has text - if so, show text handling first
    const content = extractMessageContent(originalMessage);
    const hasText = !!(content?.text && content.text.trim().length > 0);

    if (session && getSessionService()) {
      // Determine next state after selecting transform
      const context = {
        isGreenListed: false,
        isRedListed: false,
        hasText,
        isForward: false,
      };

      const nextState = SessionStateMachine.getNextState(SessionState.ACTION_SELECT, context);

      await getSessionService().updateState(session._id.toString(), nextState, {
        selectedAction: 'transform',
      });
    } else if (pending) {
      pending[1].selectedAction = 'transform';
    }

    if (hasText) {
      const keyboard = createTextHandlingKeyboard();
      await ctx.editMessageText('How should the text be handled?', {
        reply_markup: keyboard,
      });
    } else {
      // No text - try auto-selecting nickname or show selection keyboard
      const sessionId = session?._id.toString();
      await handleNicknameSelection(ctx, originalMessage, sessionId);
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

    // DUAL READ: Find session or pending forward
    const { session, pending } = await getPendingForward(
      ctx.from?.id ?? 0,
      originalMessage.message_id
    );

    let foundKey: string | undefined;
    let selectedChannel: string | undefined;
    let mediaGroupMessages: Message[] | undefined;

    if (session) {
      foundKey = session._id.toString();
      selectedChannel = session.selectedChannel;
      mediaGroupMessages = session.mediaGroupMessages;
    } else if (pending) {
      foundKey = pending[0];
      selectedChannel = pending[1].selectedChannel;
      mediaGroupMessages = pending[1].mediaGroupMessages;
    }

    if (!foundKey) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    if (!selectedChannel) {
      await ErrorMessages.channelSelectionRequired(ctx);
      return;
    }

    // Parse forward info
    const forwardInfo = parseForwardInfo(originalMessage);

    // For media groups, store all message IDs for proper forwarding
    if (mediaGroupMessages && mediaGroupMessages.length > 1) {
      forwardInfo.mediaGroupMessageIds = mediaGroupMessages.map((msg) => msg.message_id);
    }

    // Extract message content (including media group if present)
    const content = extractMessageContent(originalMessage, mediaGroupMessages);

    if (!content) {
      await ErrorMessages.unsupportedMessageType(ctx);
      return;
    }

    // Store forward action in session (showPreview handles state transition to PREVIEW)
    if (session && getSessionService()) {
      await getSessionService().update(foundKey, { selectedAction: 'forward' });
    } else if (pending) {
      pending[1].selectedAction = 'forward';
    }

    // Show preview instead of scheduling immediately
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
    if (replyChainMessagesForSchedule && replyChainMessagesForSchedule.length > 1) {
      forwardInfo.replyChainMessageIds = replyChainMessagesForSchedule.map((msg) => msg.message_id);
    }

    // Extract message content
    const content = extractMessageContent(originalMessage, mediaGroupMessages);
    if (!content) {
      await ctx.reply('Unsupported message type.');
      return;
    }

    let scheduledTime: Date;

    if (session.selectedAction === 'forward') {
      const result = await postScheduler.scheduleForwardPost({
        targetChannelId: selectedChannel,
        originalMessage,
        forwardInfo,
        content,
      });
      scheduledTime = result.scheduledTime;
    } else {
      const result = await postScheduler.scheduleTransformPost({
        targetChannelId: selectedChannel,
        originalMessage,
        forwardInfo,
        content,
        textHandling: session.textHandling ?? 'keep',
        selectedNickname: session.selectedNickname,
        customText: session.customText,
      });
      scheduledTime = result.scheduledTime;
    }

    // Delete all content preview messages (array support for reply chains/media groups)
    if (session.previewMessageIds && session.previewMessageIds.length > 0) {
      for (const msgId of session.previewMessageIds) {
        try {
          await ctx.api.deleteMessage(ctx.from!.id, msgId);
        } catch (deleteErr) {
          logger.warn(`Failed to delete preview message ${msgId}:`, deleteErr);
        }
      }
    } else if (session.previewMessageId) {
      // Backward compatibility: single preview message (old sessions)
      try {
        await ctx.api.deleteMessage(ctx.from!.id, session.previewMessageId);
      } catch (deleteErr) {
        logger.warn(`Failed to delete preview message ${session.previewMessageId}:`, deleteErr);
      }
    }

    // Delete control message (the one with Schedule/Cancel buttons)
    try {
      await ctx.deleteMessage();
    } catch (deleteErr) {
      logger.warn('Failed to delete control message:', deleteErr);
    }

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

    // Delete all content preview messages (array support for reply chains/media groups)
    if (session.previewMessageIds && session.previewMessageIds.length > 0) {
      for (const msgId of session.previewMessageIds) {
        try {
          await ctx.api.deleteMessage(ctx.from!.id, msgId);
        } catch (deleteErr) {
          logger.warn(`Failed to delete preview message ${msgId}:`, deleteErr);
        }
      }
    } else if (session.previewMessageId) {
      // Backward compatibility: single preview message (old sessions)
      try {
        await ctx.api.deleteMessage(ctx.from!.id, session.previewMessageId);
      } catch (deleteErr) {
        logger.warn(`Failed to delete preview message ${session.previewMessageId}:`, deleteErr);
      }
    }

    // Delete control message (the one with Schedule/Cancel buttons)
    try {
      await ctx.deleteMessage();
    } catch (deleteErr) {
      logger.warn('Failed to delete control message:', deleteErr);
    }

    // Delete session
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
