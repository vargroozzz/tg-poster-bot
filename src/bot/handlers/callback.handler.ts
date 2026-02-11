import { Context } from 'grammy';
import { Message } from 'grammy/types';
import { extractMessageContent, pendingForwards } from './forward.handler.js';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { transformerService } from '../../services/transformer.service.js';
import { SchedulerService } from '../../services/scheduler.service.js';
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

const schedulerService = new SchedulerService(bot.api);
const postScheduler = new PostSchedulerService();

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

    // Find and update the pending forward with selected channel
    const foundKey = await PendingForwardHelper.updateOrExpire(
      ctx,
      originalMessage.message_id,
      pendingForwards,
      { selectedChannel: selectedChannelId }
    );

    if (!foundKey) {
      return;
    }

    // Parse forward info to check if it's green-listed or red-listed
    const forwardInfo = parseForwardInfo(originalMessage);
    const shouldAutoForward = await transformerService.shouldAutoForward(forwardInfo);

    if (shouldAutoForward) {
      // Get media group messages if available
      const found = PendingForwardHelper.findByMessageId(
        originalMessage.message_id,
        pendingForwards
      );
      const mediaGroupMessages = found?.[1].mediaGroupMessages;

      // Auto-forward green-listed content
      const content = extractMessageContent(originalMessage, mediaGroupMessages);

      if (!content || !forwardInfo) {
        await ctx.editMessageText('❌ Could not process message.');
        return;
      }

      const result = await schedulerService.schedulePost(
        originalMessage,
        forwardInfo,
        'forward',
        content,
        selectedChannelId
      );

      await ctx.editMessageText(
        `✅ Auto-scheduled (green-listed channel)\n` +
          `📍 Target: ${selectedChannelId}\n` +
          `📅 Scheduled for: ${formatSlotTime(result.scheduledTime)}`
      );

      pendingForwards.delete(foundKey);
      return;
    }

    // Check if red-listed - auto-transform without asking
    const isRedListed = forwardInfo?.fromChannelId
      ? await transformerService.isRedListed(String(forwardInfo.fromChannelId))
      : false;

    if (isRedListed) {
      // Store that transform was chosen
      PendingForwardHelper.updateByMessageId(
        originalMessage.message_id,
        pendingForwards,
        { selectedAction: 'transform' }
      );

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

    // Find and update the pending forward
    const updates = action === 'add'
      ? { waitingForCustomText: true }
      : { customText: undefined };

    const foundKey = await PendingForwardHelper.updateOrExpire(
      ctx,
      originalMessage.message_id,
      pendingForwards,
      updates
    );

    if (!foundKey) {
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
    // Find the pending forward data
    let foundKey = pendingKey;
    let pending: PendingForward | undefined;

    if (pendingKey) {
      pending = pendingForwards.get(pendingKey);
    } else {
      const found = PendingForwardHelper.findByMessageId(originalMessage.message_id, pendingForwards);
      if (found) {
        [foundKey, pending] = found;
      }
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

    // Clean up
    if (foundKey) {
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

    // Parse nickname selection and update pending forward
    const selectedNickname = await NicknameHelper.parseNicknameSelection(nicknameSelection);

    const foundKey = await PendingForwardHelper.updateOrExpire(
      ctx,
      originalMessage.message_id,
      pendingForwards,
      { selectedNickname }
    );

    if (!foundKey) {
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

    // Update the pending forward with text handling choice
    const foundKey = await PendingForwardHelper.updateOrExpire(
      ctx,
      originalMessage.message_id,
      pendingForwards,
      { textHandling }
    );

    if (!foundKey) {
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

    // Store the selected action
    PendingForwardHelper.updateByMessageId(
      originalMessage.message_id,
      pendingForwards,
      { selectedAction: 'transform' }
    );

    // Check if message has text - if so, show text handling first
    const content = extractMessageContent(originalMessage);
    const hasText = content?.text && content.text.trim().length > 0;

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

    // Find the pending forward to get selected channel and media group
    const found = await PendingForwardHelper.getOrExpire(
      ctx,
      originalMessage.message_id,
      pendingForwards
    );

    if (!found) {
      return;
    }

    const [foundKey, pending] = found;
    const selectedChannel = pending.selectedChannel;
    const mediaGroupMessages = pending.mediaGroupMessages;

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

    // Clean up
    if (foundKey) {
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
