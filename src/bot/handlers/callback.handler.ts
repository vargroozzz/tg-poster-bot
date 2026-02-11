import { Context } from 'grammy';
import { Message } from 'grammy/types';
import { extractMessageContent, pendingForwards } from './forward.handler.js';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { transformerService } from '../../services/transformer.service.js';
import { SchedulerService } from '../../services/scheduler.service.js';
import { createForwardActionKeyboard } from '../keyboards/forward-action.keyboard.js';
import { createTextHandlingKeyboard } from '../keyboards/text-handling.keyboard.js';
import { createNicknameSelectKeyboard } from '../keyboards/nickname-select.keyboard.js';
import { createCustomTextKeyboard } from '../keyboards/custom-text.keyboard.js';
import { formatSlotTime } from '../../utils/time-slots.js';
import { logger } from '../../utils/logger.js';
import { bot } from '../bot.js';
import { listUserNicknames } from '../../database/models/user-nickname.model.js';

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
      // Get media group messages if available
      let mediaGroupMessages: Message[] | undefined;
      for (const [_key, value] of pendingForwards.entries()) {
        if (value.message.message_id === originalMessage.message_id) {
          mediaGroupMessages = value.mediaGroupMessages;
          break;
        }
      }

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

    // Show transform/forward options
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

// Handle custom text selection
bot.callbackQuery(/^custom_text:(add|skip)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();

    const match = ctx.callbackQuery?.data?.match(/^custom_text:(add|skip)$/);
    const action = match?.[1];

    if (!action) {
      await ctx.editMessageText('❌ Invalid action.');
      return;
    }

    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;

    if (!originalMessage) {
      await ctx.editMessageText('❌ Original message not found. Please forward again.');
      return;
    }

    // Find the pending forward
    let foundKey: string | undefined;
    for (const [key, value] of pendingForwards.entries()) {
      if (value.message.message_id === originalMessage.message_id) {
        if (action === 'add') {
          // Set waiting flag and ask for text
          value.waitingForCustomText = true;
          foundKey = key;
        } else {
          // Skip custom text
          value.customText = undefined;
          foundKey = key;
        }
        break;
      }
    }

    if (!foundKey) {
      await ctx.editMessageText('❌ Session expired. Please forward the message again.');
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
    logger.error('Error in custom text callback:', error);
    await ctx.editMessageText('❌ Error processing custom text. Please try again.').catch(() => {
      ctx.reply('❌ Error processing custom text. Please try again.');
    });
  }
});

// Helper function to schedule a transform post
async function scheduleTransformPost(ctx: Context, originalMessage: Message, pendingKey?: string) {
  try {
    // Find the pending forward data
    let selectedChannel: string | undefined;
    let textHandling: 'keep' | 'remove' | 'quote' = 'keep';
    let selectedNickname: string | null | undefined;
    let customText: string | undefined;
    let mediaGroupMessages: Message[] | undefined;
    let foundKey: string | undefined = pendingKey;

    for (const [key, value] of pendingForwards.entries()) {
      if (value.message.message_id === originalMessage.message_id) {
        selectedChannel = value.selectedChannel;
        textHandling = value.textHandling ?? 'keep';
        selectedNickname = value.selectedNickname;
        customText = value.customText;
        mediaGroupMessages = value.mediaGroupMessages;
        if (!foundKey) foundKey = key;
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
    const content = extractMessageContent(originalMessage, mediaGroupMessages);

    if (!content) {
      await ctx.editMessageText('❌ Unsupported message type.');
      return;
    }

    // Transform the message
    const originalText = content.text ?? '';
    const transformedText = await transformerService.transformMessage(
      originalText,
      forwardInfo,
      'transform',
      textHandling,
      selectedNickname,
      customText
    );

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
    logger.error('Error scheduling transform post:', error);
    await ctx.editMessageText('❌ Error scheduling post. Please try again.').catch(() => {
      ctx.reply('❌ Error scheduling post. Please try again.');
    });
  }
}

// Handle nickname selection
bot.callbackQuery(/^select_nickname:(.+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();

    const match = ctx.callbackQuery?.data?.match(/^select_nickname:(.+)$/);
    const nicknameSelection = match?.[1];

    if (!nicknameSelection) {
      await ctx.editMessageText('❌ Invalid nickname selection.');
      return;
    }

    // Find the original message
    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;

    if (!originalMessage) {
      await ctx.editMessageText('❌ Original message not found. Please forward again.');
      return;
    }

    // Update the pending forward with nickname selection
    let foundKey: string | undefined;
    for (const [key, value] of pendingForwards.entries()) {
      if (value.message.message_id === originalMessage.message_id) {
        // "none" means no attribution, store as null
        // Otherwise store the nickname text
        if (nicknameSelection === 'none') {
          value.selectedNickname = null;
        } else {
          // nicknameSelection is userId, need to get the actual nickname
          const userId = parseInt(nicknameSelection, 10);
          const nicknames = await listUserNicknames();
          const found = nicknames.find((n) => n.userId === userId);
          value.selectedNickname = found?.nickname ?? null;
        }
        foundKey = key;
        break;
      }
    }

    if (!foundKey) {
      await ctx.editMessageText('❌ Session expired. Please forward the message again.');
      return;
    }

    // Show custom text keyboard
    const keyboard = createCustomTextKeyboard();

    await ctx.editMessageText('Do you want to add custom text to this post?', {
      reply_markup: keyboard,
    });

    logger.debug(`Nickname "${nicknameSelection}" selected for message ${originalMessage.message_id}`);
  } catch (error) {
    logger.error('Error in nickname selection callback:', error);
    await ctx.editMessageText('❌ Error processing nickname selection. Please try again.').catch(() => {
      ctx.reply('❌ Error processing nickname selection. Please try again.');
    });
  }
});

// Handle text handling selection
bot.callbackQuery(/^text:(keep|remove|quote)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();

    const match = ctx.callbackQuery?.data?.match(/^text:(keep|remove|quote)$/);
    const textHandling = match?.[1] as 'keep' | 'remove' | 'quote';

    if (!textHandling) {
      await ctx.editMessageText('❌ Invalid text handling option.');
      return;
    }

    // Find the original message
    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;

    if (!originalMessage) {
      await ctx.editMessageText('❌ Original message not found. Please forward again.');
      return;
    }

    // Update the pending forward with text handling choice
    let foundKey: string | undefined;
    for (const [key, value] of pendingForwards.entries()) {
      if (value.message.message_id === originalMessage.message_id) {
        value.textHandling = textHandling;
        foundKey = key;
        break;
      }
    }

    if (!foundKey) {
      await ctx.editMessageText('❌ Session expired. Please forward the message again.');
      return;
    }

    // After text handling, proceed to nickname selection (if from channel) or custom text
    const forwardInfo = parseForwardInfo(originalMessage);
    const isFromChannel = forwardInfo?.fromChannelId !== undefined;

    if (isFromChannel) {
      // Show nickname selection
      const nicknames = await listUserNicknames();
      const nicknameOptions = nicknames.map((n) => ({
        userId: n.userId,
        nickname: n.nickname,
      }));
      const keyboard = createNicknameSelectKeyboard(nicknameOptions);

      await ctx.editMessageText('Who should be credited for this post?', {
        reply_markup: keyboard,
      });
    } else {
      // Not from channel, show custom text option
      const keyboard = createCustomTextKeyboard();
      await ctx.editMessageText('Do you want to add custom text to this post?', {
        reply_markup: keyboard,
      });
    }

    logger.debug(`Text handling "${textHandling}" selected for message ${originalMessage.message_id}`);
  } catch (error) {
    logger.error('Error in text handling callback:', error);
    await ctx.editMessageText('❌ Error processing text handling. Please try again.').catch(() => {
      ctx.reply('❌ Error processing text handling. Please try again.');
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

    // Store the selected action
    for (const [_key, value] of pendingForwards.entries()) {
      if (value.message.message_id === originalMessage.message_id) {
        value.selectedAction = 'transform';
        break;
      }
    }

    // Check if message has text - if so, show text handling first
    const content = extractMessageContent(originalMessage);
    const hasText = content?.text && content.text.trim().length > 0;

    if (hasText) {
      const keyboard = createTextHandlingKeyboard();
      await ctx.editMessageText('How should the text be handled?', {
        reply_markup: keyboard,
      });
    } else {
      // No text - check if from channel to show nickname selection
      const forwardInfo = parseForwardInfo(originalMessage);
      const isFromChannel = forwardInfo?.fromChannelId !== undefined;

      if (isFromChannel) {
        // Show nickname selection
        const nicknames = await listUserNicknames();
        const nicknameOptions = nicknames.map((n) => ({
          userId: n.userId,
          nickname: n.nickname,
        }));
        const keyboard = createNicknameSelectKeyboard(nicknameOptions);

        await ctx.editMessageText('Who should be credited for this post?', {
          reply_markup: keyboard,
        });
      } else {
        // Not from channel, show custom text option
        const keyboard = createCustomTextKeyboard();
        await ctx.editMessageText('Do you want to add custom text to this post?', {
          reply_markup: keyboard,
        });
      }
    }

    logger.debug(`Transform action selected for message ${originalMessage.message_id}`);
  } catch (error) {
    logger.error('Error in transform callback:', error);
    await ctx.editMessageText('❌ Error processing transform. Please try again.').catch(() => {
      ctx.reply('❌ Error processing transform. Please try again.');
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

    // Find the pending forward to get selected channel and media group
    let selectedChannel: string | undefined;
    let mediaGroupMessages: Message[] | undefined;
    let foundKey: string | undefined;

    for (const [key, value] of pendingForwards.entries()) {
      if (value.message.message_id === originalMessage.message_id) {
        selectedChannel = value.selectedChannel;
        mediaGroupMessages = value.mediaGroupMessages;
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

    // Extract message content (including media group if present)
    const content = extractMessageContent(originalMessage, mediaGroupMessages);

    if (!content) {
      await ctx.editMessageText('❌ Unsupported message type.');
      return;
    }

    // Forward schedules with original text, no modifications
    const processedText = await transformerService.transformMessage(
      content.text ?? '',
      forwardInfo,
      'forward',
      'keep', // Always keep text for forward
      undefined, // No nickname
      undefined // No custom text
    );

    // Update content with processed text
    const processedContent = {
      ...content,
      text: processedText,
    };

    // Schedule the post
    const result = await schedulerService.schedulePost(
      originalMessage,
      forwardInfo,
      'forward',
      processedContent,
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
