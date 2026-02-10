import { Context } from 'grammy';
import { Message } from 'grammy/types';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { transformerService } from '../../services/transformer.service.js';
import { createChannelSelectKeyboard } from '../keyboards/channel-select.keyboard.js';
import { logger } from '../../utils/logger.js';
import { bot } from '../bot.js';
import type { MessageContent } from '../../types/message.types.js';
import { getActivePostingChannels } from '../../database/models/posting-channel.model.js';

// Store forwarded message data temporarily (in-memory for simplicity)
// In production, consider using Grammy's conversation plugin or Redis
interface PendingForward {
  message: Message;
  selectedChannel?: string;
  textHandling?: 'keep' | 'remove' | 'quote';
  selectedNickname?: string | null; // null = "No attribution", undefined = not selected yet
  timestamp: number;
}

const pendingForwards = new Map<string, PendingForward>();

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

bot.on('message:forward_origin', async (ctx: Context) => {
  try {
    const message = ctx.message;

    if (!message) {
      return;
    }

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

    // Parse forward information
    const forwardInfo = parseForwardInfo(message);

    if (!forwardInfo) {
      await ctx.reply('❌ Could not parse forward information.');
      return;
    }

    // Check if from a green-listed channel - show channels but mark as auto-forward
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

    await ctx.reply(`📍 Select target channel for this post:${greenListNote}`, {
      reply_markup: keyboard,
      reply_to_message_id: message.message_id,
    });
  } catch (error) {
    logger.error('Error handling forward:', error);
    await ctx.reply('❌ Error processing forward. Please try again.');
  }
});

export function extractMessageContent(message: Message): MessageContent | null {
  // Check if this is part of a media group (album with multiple photos/videos)
  if ('media_group_id' in message && message.media_group_id) {
    // Media groups need special handling
    // For now, we'll handle single media from the group
    // TODO: Implement full media group support
    logger.warn(`Message ${message.message_id} is part of media group ${message.media_group_id} - only first media will be posted`);
  }

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

// Export for use in callback handler
export { pendingForwards };
