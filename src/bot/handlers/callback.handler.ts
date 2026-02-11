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
 * Convert Session to PendingForward for compatibility
 */
function sessionToPendingForward(session: ISession): PendingForward {
  return {
    message: session.originalMessage,
    selectedChannel: session.selectedChannel,
    textHandling: session.textHandling,
    selectedAction: session.selectedAction,
    selectedNickname: session.selectedNickname,
    customText: session.customText,
    waitingForCustomText: session.waitingForCustomText,
    mediaGroupMessages: session.mediaGroupMessages,
    timestamp: session.createdAt.getTime(),
  };
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
        // No text - show nickname selection
        const keyboard = await NicknameHelper.getNicknameKeyboard();

        await ctx.editMessageText('Who should be credited for this post?', {
          reply_markup: keyboard,
        });
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
      // For custom text, we either wait for input or proceed to completion
      // Keep state as CUSTOM_TEXT while waiting, or transition to COMPLETED
      const nextState = action === 'add' ? SessionState.CUSTOM_TEXT : SessionState.COMPLETED;

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
      // Skip custom text - schedule the post now
      await scheduleTransformPost(ctx, originalMessage, foundKey);
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

// Helper function to schedule a transform post
async function scheduleTransformPost(ctx: Context, originalMessage: Message, pendingKey?: string) {
  try {
    // DUAL READ: Find session or pending forward
    let session: ISession | undefined;
    let pending: PendingForward | undefined;
    let foundKey = pendingKey;

    if (pendingKey) {
      // Try to determine if pendingKey is a session ID or Map key
      const sessionSvc = getSessionService();
      if (sessionSvc) {
        session = await sessionSvc.findById(pendingKey) ?? undefined;
      }
      if (!session) {
        pending = pendingForwards.get(pendingKey);
      }
    } else {
      const result = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      session = result.session;
      if (result.pending) {
        [foundKey, pending] = result.pending;
      }
    }

    // Convert session to pending format if needed
    if (session && !pending) {
      pending = sessionToPendingForward(session);
      foundKey = session._id.toString();
    }

    if (!pending) {
      await ErrorMessages.channelSelectionRequired(ctx);
      return;
    }

    const selectedChannel = pending.selectedChannel;
    const textHandling = pending.textHandling ?? 'keep';
    const selectedNickname = pending.selectedNickname;
    const customText = pending.customText;
    const mediaGroupMessages = pending.mediaGroupMessages;

    if (!selectedChannel) {
      await ErrorMessages.channelSelectionRequired(ctx);
      return;
    }

    // Parse forward info
    const forwardInfo = parseForwardInfo(originalMessage);

    // Extract message content
    const content = extractMessageContent(originalMessage, mediaGroupMessages);

    if (!content) {
      await ErrorMessages.unsupportedMessageType(ctx);
      return;
    }

    // Schedule using the unified scheduler service
    const result = await postScheduler.scheduleTransformPost({
      targetChannelId: selectedChannel,
      originalMessage,
      forwardInfo,
      content,
      textHandling,
      selectedNickname,
      customText,
    });

    await ctx.editMessageText(
      `✅ Post scheduled with transformation\n` +
        `📍 Target: ${selectedChannel}\n` +
        `📅 Scheduled for: ${formatSlotTime(result.scheduledTime)}`
    );

    logger.info(
      `Successfully scheduled transformed post to ${selectedChannel} for ${formatSlotTime(result.scheduledTime)}`
    );

    // Clean up: Delete from both DB and Map
    if (foundKey) {
      if (session && getSessionService()) {
        await getSessionService().complete(session._id.toString());
      }
      pendingForwards.delete(foundKey);
    }
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error scheduling post. Please try again.',
      'Error scheduling transform post'
    );
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

    // After text handling, proceed to nickname selection
    const keyboard = await NicknameHelper.getNicknameKeyboard();

    await ctx.editMessageText('Who should be credited for this post?', {
      reply_markup: keyboard,
    });

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
      // No text - show nickname selection for all messages
      const keyboard = await NicknameHelper.getNicknameKeyboard();

      await ctx.editMessageText('Who should be credited for this post?', {
        reply_markup: keyboard,
      });
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

    // Extract message content (including media group if present)
    const content = extractMessageContent(originalMessage, mediaGroupMessages);

    if (!content) {
      await ErrorMessages.unsupportedMessageType(ctx);
      return;
    }

    // Schedule using the unified scheduler service
    const result = await postScheduler.scheduleForwardPost({
      targetChannelId: selectedChannel,
      originalMessage,
      forwardInfo,
      content,
    });

    await ctx.editMessageText(
      `✅ Post scheduled as-is\n` +
        `📍 Target: ${selectedChannel}\n` +
        `📅 Scheduled for: ${formatSlotTime(result.scheduledTime)}`
    );

    logger.info(
      `Successfully scheduled forward post to ${selectedChannel} for ${formatSlotTime(result.scheduledTime)}`
    );

    // Clean up: Delete from both DB and Map
    if (foundKey) {
      if (session && getSessionService()) {
        await getSessionService().complete(session._id.toString());
      }
      pendingForwards.delete(foundKey);
    }
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error scheduling post. Please try again.',
      'Error in forward callback'
    );
  }
});
