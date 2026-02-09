import { Context } from 'grammy';
import { extractMessageContent, pendingForwards } from './forward.handler.js';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { transformerService } from '../../services/transformer.service.js';
import { SchedulerService } from '../../services/scheduler.service.js';
import { createForwardActionKeyboard } from '../keyboards/forward-action.keyboard.js';
import { formatSlotTime } from '../../utils/time-slots.js';
import { logger } from '../../utils/logger.js';
import { bot } from '../bot.js';

const schedulerService = new SchedulerService(bot.api);

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
      await ctx.editMessageText('❌ Original message not found. Please forward again.');
      return;
    }

    // Find and update the pending forward with selected channel
    let foundKey: string | undefined;
    for (const [key, value] of pendingForwards.entries()) {
      if (value.message.message_id === originalMessage.message_id) {
        value.selectedChannel = selectedChannelId;
        foundKey = key;
        break;
      }
    }

    if (!foundKey) {
      await ctx.editMessageText('❌ Session expired. Please forward the message again.');
      return;
    }

    // Parse forward info to check if it's green-listed
    const forwardInfo = parseForwardInfo(originalMessage);
    const shouldAutoForward = forwardInfo
      ? await transformerService.shouldAutoForward(forwardInfo)
      : false;

    if (shouldAutoForward) {
      // Auto-forward green-listed content
      const content = extractMessageContent(originalMessage);

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

    // Show Transform/Forward action buttons
    const keyboard = createForwardActionKeyboard();

    await ctx.editMessageText('Choose how to post this message:', {
      reply_markup: keyboard,
    });

    logger.debug(`Channel ${selectedChannelId} selected for message ${originalMessage.message_id}`);
  } catch (error) {
    logger.error('Error in channel selection callback:', error);
    await ctx.editMessageText('❌ Error processing channel selection. Please try again.').catch(() => {
      ctx.reply('❌ Error processing channel selection. Please try again.');
    });
  }
});

bot.callbackQuery('action:transform', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();

    // Find the original message from pending forwards
    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;

    if (!originalMessage) {
      await ctx.editMessageText('❌ Original message not found. Please forward again.');
      return;
    }

    // Find the pending forward to get selected channel
    let selectedChannel: string | undefined;
    let foundKey: string | undefined;

    for (const [key, value] of pendingForwards.entries()) {
      if (value.message.message_id === originalMessage.message_id) {
        selectedChannel = value.selectedChannel;
        foundKey = key;
        break;
      }
    }

    if (!selectedChannel) {
      await ctx.editMessageText('❌ No channel selected. Please forward the message again.');
      return;
    }

    // Parse forward info
    const forwardInfo = parseForwardInfo(originalMessage);

    if (!forwardInfo) {
      await ctx.editMessageText('❌ Could not parse forward information.');
      return;
    }

    // Extract message content
    const content = extractMessageContent(originalMessage);

    if (!content) {
      await ctx.editMessageText('❌ Unsupported message type.');
      return;
    }

    // Transform the message text
    const originalText = content.text ?? '';
    const transformedText = await transformerService.transformMessage(
      originalText,
      forwardInfo,
      'transform'
    );

    // Update content with transformed text
    const transformedContent = {
      ...content,
      text: transformedText,
    };

    // Schedule the post
    const result = await schedulerService.schedulePost(
      originalMessage,
      forwardInfo,
      'transform',
      transformedContent,
      selectedChannel
    );

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
    logger.error('Error in transform callback:', error);
    await ctx.editMessageText('❌ Error scheduling post. Please try again.').catch(() => {
      // If edit fails, send a new message
      ctx.reply('❌ Error scheduling post. Please try again.');
    });
  }
});

bot.callbackQuery('action:forward', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();

    // Find the original message
    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;

    if (!originalMessage) {
      await ctx.editMessageText('❌ Original message not found. Please forward again.');
      return;
    }

    // Find the pending forward to get selected channel
    let selectedChannel: string | undefined;
    let foundKey: string | undefined;

    for (const [key, value] of pendingForwards.entries()) {
      if (value.message.message_id === originalMessage.message_id) {
        selectedChannel = value.selectedChannel;
        foundKey = key;
        break;
      }
    }

    if (!selectedChannel) {
      await ctx.editMessageText('❌ No channel selected. Please forward the message again.');
      return;
    }

    // Parse forward info
    const forwardInfo = parseForwardInfo(originalMessage);

    if (!forwardInfo) {
      await ctx.editMessageText('❌ Could not parse forward information.');
      return;
    }

    // Extract message content (no transformation)
    const content = extractMessageContent(originalMessage);

    if (!content) {
      await ctx.editMessageText('❌ Unsupported message type.');
      return;
    }

    // Schedule the post as-is
    const result = await schedulerService.schedulePost(
      originalMessage,
      forwardInfo,
      'forward',
      content,
      selectedChannel
    );

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
    logger.error('Error in forward callback:', error);
    await ctx.editMessageText('❌ Error scheduling post. Please try again.').catch(() => {
      // If edit fails, send a new message
      ctx.reply('❌ Error scheduling post. Please try again.');
    });
  }
});
