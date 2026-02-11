import { Context } from 'grammy';
import { Message } from 'grammy/types';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { transformerService } from '../../services/transformer.service.js';
import { createChannelSelectKeyboard } from '../keyboards/channel-select.keyboard.js';
import { logger } from '../../utils/logger.js';
import { bot } from '../bot.js';
import type { MessageContent } from '../../types/message.types.js';
import { getActivePostingChannels } from '../../database/models/posting-channel.model.js';
import { SchedulerService } from '../../services/scheduler.service.js';
import { formatSlotTime } from '../../utils/time-slots.js';

const schedulerService = new SchedulerService(bot.api);

// Store forwarded message data temporarily (in-memory for simplicity)
// In production, consider using Grammy's conversation plugin or Redis
interface PendingForward {
  message: Message;
  selectedChannel?: string;
  textHandling?: 'keep' | 'remove' | 'quote';
  selectedAction?: 'transform' | 'forward'; // Which action was chosen
  selectedNickname?: string | null; // null = "No attribution", undefined = not selected yet
  customText?: string; // Optional custom text to prepend
  waitingForCustomText?: boolean; // Flag to indicate waiting for text input
  mediaGroupMessages?: Message[]; // For collecting media group items
  timestamp: number;
}

const pendingForwards = new Map<string, PendingForward>();

// Store media group buffers temporarily
interface MediaGroupBuffer {
  messages: Message[];
  timeout: NodeJS.Timeout;
}

const mediaGroupBuffers = new Map<string, MediaGroupBuffer>();

// Clean up old pending forwards every 5 minutes
setInterval(() => {
  const now = Date.now();
  const ttl = 24 * 60 * 60 * 1000; // 24 hours

  for (const [key, value] of pendingForwards.entries()) {
    if (now - value.timestamp > ttl) {
      pendingForwards.delete(key);
      logger.debug(`Cleaned up expired pending forward: ${key}`);
    }
  }
}, 5 * 60 * 1000);

// Handle text messages when waiting for custom text input
bot.on('message:text', async (ctx: Context) => {
  try {
    const message = ctx.message;

    if (!message) {
      return;
    }

    // Check if this is a reply to our bot message and we're waiting for custom text
    const replyToMessage = message.reply_to_message;
    if (!replyToMessage || !('text' in replyToMessage)) {
      return; // Not a reply or not replying to text message
    }

    // Find if there's a pending forward waiting for custom text
    let foundEntry: [string, PendingForward] | undefined;
    for (const entry of pendingForwards.entries()) {
      const [_key, value] = entry;
      if (value.waitingForCustomText) {
        foundEntry = entry;
        break;
      }
    }

    if (!foundEntry) {
      return; // Not waiting for custom text
    }

    const [_foundKey, pendingForward] = foundEntry;

    // Store the custom text
    pendingForward.customText = message.text;
    pendingForward.waitingForCustomText = false;

    // Schedule the post now (custom text is the final step)
    await scheduleTransformPostFromForwardHandler(ctx, pendingForward, _foundKey);

    logger.debug(`Custom text added and post scheduled for message ${pendingForward.message.message_id}`);
  } catch (error) {
    logger.error('Error handling custom text input:', error);
  }
});

// Handle both forwarded and non-forwarded messages
bot.on(['message:forward_origin', 'message:photo', 'message:video', 'message:document', 'message:animation'], async (ctx: Context) => {
  try {
    const message = ctx.message;

    if (!message) {
      return;
    }

    // Check if this is part of a media group
    const mediaGroupId = 'media_group_id' in message ? message.media_group_id : undefined;

    if (mediaGroupId) {
      // Buffer this message
      const buffer = mediaGroupBuffers.get(mediaGroupId);

      if (buffer) {
        // Add to existing buffer
        buffer.messages.push(message);
        // Reset timeout
        clearTimeout(buffer.timeout);
        buffer.timeout = setTimeout(() => {
          processMediaGroup(mediaGroupId).catch((error) => {
            logger.error('Error processing media group:', error);
          });
        }, 1000); // Wait 1 second for all messages
      } else {
        // Create new buffer
        const timeout = setTimeout(() => {
          processMediaGroup(mediaGroupId).catch((error) => {
            logger.error('Error processing media group:', error);
          });
        }, 1000);

        mediaGroupBuffers.set(mediaGroupId, {
          messages: [message],
          timeout,
        });
      }

      return; // Don't process yet
    }

    // Single message (not part of media group)
    await processSingleMessage(ctx, message);
  } catch (error) {
    logger.error('Error handling message:', error);
    await ctx.reply('❌ Error processing message. Please try again.');
  }
});

async function processSingleMessage(ctx: Context, message: Message) {
  // Get available posting channels
  const postingChannels = await getActivePostingChannels();

  if (postingChannels.length === 0) {
    await ctx.reply(
      '⚠️ No posting channels configured.\n\n' +
        'Please add channels first using /addchannel command.\n' +
        'Example: /addchannel -1001234567890'
    );
    return;
  }

  // Parse forward information (will have minimal info for non-forwarded messages)
  const forwardInfo = parseForwardInfo(message);

  // Check if from a green-listed channel
  const shouldAutoForward = await transformerService.shouldAutoForward(forwardInfo);

  // Create channel selection keyboard
  const channels = postingChannels.map((ch) => ({
    id: ch.channelId,
    title: ch.channelTitle ?? ch.channelId,
    username: ch.channelUsername,
  }));

  const keyboard = createChannelSelectKeyboard(channels);

  // Store message data with unique key
  const callbackKey = `${ctx.from?.id}_${message.message_id}_${Date.now()}`;
  pendingForwards.set(callbackKey, {
    message,
    timestamp: Date.now(),
  });

  const greenListNote = shouldAutoForward
    ? '\n\n🟢 This is from a green-listed channel - will be forwarded as-is.'
    : '';

  const messageType = forwardInfo ? 'post' : 'message';
  await ctx.reply(`📍 Select target channel for this ${messageType}:${greenListNote}`, {
    reply_markup: keyboard,
    reply_to_message_id: message.message_id,
  });
}

async function processMediaGroup(mediaGroupId: string) {
  const buffer = mediaGroupBuffers.get(mediaGroupId);

  if (!buffer) {
    return;
  }

  // Clean up buffer
  clearTimeout(buffer.timeout);
  mediaGroupBuffers.delete(mediaGroupId);

  const messages = buffer.messages;

  if (messages.length === 0) {
    return;
  }

  // Use the first message as the primary message
  const primaryMessage = messages[0];

  // Get available posting channels
  const postingChannels = await getActivePostingChannels();

  if (postingChannels.length === 0) {
    await bot.api.sendMessage(
      primaryMessage.chat.id,
      '⚠️ No posting channels configured.\n\n' +
        'Please add channels first using /addchannel command.\n' +
        'Example: /addchannel -1001234567890'
    );
    return;
  }

  // Parse forward information from primary message
  const forwardInfo = parseForwardInfo(primaryMessage);

  // Check if from a green-listed channel
  const shouldAutoForward = await transformerService.shouldAutoForward(forwardInfo);

  // Create channel selection keyboard
  const channels = postingChannels.map((ch) => ({
    id: ch.channelId,
    title: ch.channelTitle ?? ch.channelId,
    username: ch.channelUsername,
  }));

  const keyboard = createChannelSelectKeyboard(channels);

  // Store message data with all media group messages
  const callbackKey = `${primaryMessage.from?.id}_${primaryMessage.message_id}_${Date.now()}`;
  pendingForwards.set(callbackKey, {
    message: primaryMessage,
    mediaGroupMessages: messages,
    timestamp: Date.now(),
  });

  const greenListNote = shouldAutoForward
    ? '\n\n🟢 This is from a green-listed channel - will be forwarded as-is.'
    : '';

  await bot.api.sendMessage(
    primaryMessage.chat.id,
    `📍 Select target channel for this album (${messages.length} items):${greenListNote}`,
    {
      reply_markup: keyboard,
      reply_to_message_id: primaryMessage.message_id,
    }
  );
}

export function extractMessageContent(
  message: Message,
  mediaGroupMessages?: Message[]
): MessageContent | null {
  // If media group messages provided, create media group content
  if (mediaGroupMessages && mediaGroupMessages.length > 1) {
    const mediaItems: Array<{ type: 'photo' | 'video'; fileId: string }> = [];
    let caption: string | undefined;

    for (const msg of mediaGroupMessages) {
      if ('photo' in msg && msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1];
        mediaItems.push({ type: 'photo', fileId: photo.file_id });
        if (!caption && msg.caption) {
          caption = msg.caption;
        }
      } else if ('video' in msg && msg.video) {
        mediaItems.push({ type: 'video', fileId: msg.video.file_id });
        if (!caption && msg.caption) {
          caption = msg.caption;
        }
      }
    }

    if (mediaItems.length > 0) {
      return {
        type: 'media_group',
        mediaGroup: mediaItems,
        text: caption,
      };
    }
  }

  // Single message handling
  if ('photo' in message && message.photo && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1]; // Get highest quality
    return {
      type: 'photo',
      fileId: photo.file_id,
      text: message.caption,
    };
  }

  if ('video' in message && message.video) {
    return {
      type: 'video',
      fileId: message.video.file_id,
      text: message.caption,
    };
  }

  if ('document' in message && message.document) {
    return {
      type: 'document',
      fileId: message.document.file_id,
      text: message.caption,
    };
  }

  if ('animation' in message && message.animation) {
    return {
      type: 'animation',
      fileId: message.animation.file_id,
      text: message.caption,
    };
  }

  if ('text' in message && message.text) {
    return {
      type: 'text',
      text: message.text,
    };
  }

  return null;
}

// Helper function to schedule a transform post
async function scheduleTransformPostFromForwardHandler(
  ctx: Context,
  pendingForward: PendingForward,
  pendingKey: string
) {
  try {
    const originalMessage = pendingForward.message;
    const selectedChannel = pendingForward.selectedChannel;
    const textHandling = pendingForward.textHandling ?? 'keep';
    const selectedNickname = pendingForward.selectedNickname;
    const customText = pendingForward.customText;
    const mediaGroupMessages = pendingForward.mediaGroupMessages;

    if (!selectedChannel) {
      await ctx.reply('❌ No channel selected. Please forward the message again.');
      return;
    }

    // Parse forward info
    const forwardInfo = parseForwardInfo(originalMessage);

    // Extract message content
    const content = extractMessageContent(originalMessage, mediaGroupMessages);

    if (!content) {
      await ctx.reply('❌ Unsupported message type.');
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

    await ctx.reply(
      `✅ Post scheduled with transformation\n` +
        `📍 Target: ${selectedChannel}\n` +
        `📅 Scheduled for: ${formatSlotTime(result.scheduledTime)}`,
      {
        reply_to_message_id: originalMessage.message_id,
      }
    );

    logger.info(
      `Successfully scheduled transformed post to ${selectedChannel} for ${formatSlotTime(result.scheduledTime)}`
    );

    // Clean up
    pendingForwards.delete(pendingKey);
  } catch (error) {
    logger.error('Error scheduling transform post:', error);
    await ctx.reply('❌ Error scheduling post. Please try again.');
  }
}

// Export for use in callback handler
export { pendingForwards };
