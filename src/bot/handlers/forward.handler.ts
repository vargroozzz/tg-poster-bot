import { Context } from 'grammy';
import { Message } from 'grammy/types';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { transformerService } from '../../services/transformer.service.js';
import { createChannelSelectKeyboard } from '../keyboards/channel-select.keyboard.js';
import { logger } from '../../utils/logger.js';
import { bot } from '../bot.js';
import type { MessageContent } from '../../types/message.types.js';
import { getActivePostingChannels } from '../../database/models/posting-channel.model.js';
import { formatSlotTime } from '../../utils/time-slots.js';
import type { PendingForward } from '../../shared/helpers/pending-forward-finder.js';
import { PostSchedulerService } from '../../core/posting/post-scheduler.service.js';
import { DIContainer } from '../../shared/di/container.js';
import type { SessionService } from '../../core/session/session.service.js';
import type { ISession } from '../../database/models/session.model.js';
import { SessionState } from '../../shared/constants/flow-states.js';
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

// Store forwarded message data temporarily (in-memory Map)
// Note: Database-backed sessions are now implemented (see SessionService)
// This Map is kept for dual-write compatibility during migration
export const pendingForwards = new Map<string, PendingForward>();

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
// Only listen to messages that are replies (to filter out forwarded text messages)
bot.on('message:text').filter((ctx) => !!ctx.message?.reply_to_message, async (ctx: Context) => {
  try {
    const message = ctx.message;

    if (!message) {
      return;
    }

    // Check if this is a reply to a text message (our custom text prompt)
    const replyToMessage = message.reply_to_message;
    if (!replyToMessage || !('text' in replyToMessage)) {
      return; // Not replying to text message
    }

    const userId = ctx.from?.id;
    if (!userId) {
      return;
    }

    // DUAL READ: Find session waiting for custom text (DB first, then Map)
    let session: ISession | undefined;
    let foundEntry: [string, PendingForward] | undefined;
    let foundKey: string | undefined;

    // Try database first
    const sessionSvc = getSessionService();
    if (sessionSvc) {
      try {
        session = await sessionSvc.findWaitingForCustomText(userId) ?? undefined;
        if (session) {
          foundKey = session._id.toString();
          logger.debug(`Found session waiting for custom text in DB for user ${userId}`);
        }
      } catch (error) {
        logger.error('Error fetching session from DB, falling back to Map:', error);
      }
    }

    // Fall back to Map if not found in DB
    if (!session) {
      for (const [key, value] of pendingForwards.entries()) {
        if (value.waitingForCustomText) {
          foundEntry = [key, value];
          foundKey = key;
          logger.debug(`Found session waiting for custom text in Map for user ${userId}`);
          break;
        }
      }

      if (!foundEntry) {
        return; // Not waiting for custom text
      }
    }

    // Update with custom text
    const customText = message.text;

    if (session && sessionSvc && foundKey) {
      // Update session with custom text, transition to PREVIEW state
      await sessionSvc.updateState(foundKey, SessionState.PREVIEW, {
        customText,
        waitingForCustomText: false,
      });

      // Fetch updated session for preview generation
      const updatedSession = await sessionSvc.findById(foundKey);
      if (!updatedSession) {
        await ctx.reply('⚠️ Session not found. Please try again.');
        return;
      }

      // Generate preview content
      const previewGenerator = new PreviewGeneratorService();
      const previewContent = await previewGenerator.generatePreview(updatedSession);

      // Send preview to user's chat
      const previewSender = new PreviewSenderService(ctx.api);
      const previewMessageId = await previewSender.sendPreview(ctx.from!.id, previewContent, foundKey);

      // Store preview message ID in session
      await sessionSvc.update(foundKey, { previewMessageId });

      await ctx.reply('👁️ Preview sent above. Click Schedule when ready.');
      logger.debug(`Preview shown after custom text for session ${foundKey}`);
    } else if (foundEntry) {
      // Update Map entry (legacy path)
      const [key, pendingForward] = foundEntry;
      pendingForward.customText = customText;
      pendingForward.waitingForCustomText = false;

      // Schedule the post
      await scheduleTransformPostFromForwardHandler(ctx, pendingForward, key);
    }

    logger.debug(`Custom text added and post scheduled for user ${userId}`);
  } catch (error) {
    logger.error('Error handling custom text input:', error);
  }
});

// Handle both forwarded and non-forwarded messages
bot.on(['message:forward_origin', 'message:photo', 'message:video', 'message:document', 'message:animation', 'message:text'], async (ctx: Context) => {
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
  // Idempotency check: Skip if we already have a session for this message
  // This prevents duplicate processing during zero-downtime deployments
  const sessionSvc = getSessionService();
  if (sessionSvc && ctx.from?.id) {
    try {
      const existingSession = await sessionSvc.findByMessage(ctx.from.id, message.message_id);
      if (existingSession) {
        logger.debug(`Session already exists for message ${message.message_id}, skipping duplicate processing`);
        return;
      }
    } catch (error) {
      logger.error('Error checking for existing session:', error);
      // Continue processing if check fails (fail open)
    }
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

  // DUAL WRITE: Store in both Map (legacy) and Database (new)
  const callbackKey = `${ctx.from?.id}_${message.message_id}_${Date.now()}`;
  pendingForwards.set(callbackKey, {
    message,
    timestamp: Date.now(),
  });

  // Also write to database for session persistence (reuse sessionSvc from above)
  if (sessionSvc && ctx.from?.id) {
    try {
      await sessionSvc.create(ctx.from.id, message);
      logger.debug(`Session created in DB for message ${message.message_id}`);
    } catch (error) {
      logger.error('Failed to create session in DB, using Map fallback:', error);
    }
  }

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

  // For media groups, store all message IDs for proper forwarding
  if (forwardInfo && messages.length > 1) {
    forwardInfo.mediaGroupMessageIds = messages.map((msg) => msg.message_id);
  }

  // Check if from a green-listed channel
  const shouldAutoForward = await transformerService.shouldAutoForward(forwardInfo);

  // Create channel selection keyboard
  const channels = postingChannels.map((ch) => ({
    id: ch.channelId,
    title: ch.channelTitle ?? ch.channelId,
    username: ch.channelUsername,
  }));

  const keyboard = createChannelSelectKeyboard(channels);

  // DUAL WRITE: Store in both Map (legacy) and Database (new)
  const callbackKey = `${primaryMessage.from?.id}_${primaryMessage.message_id}_${Date.now()}`;
  pendingForwards.set(callbackKey, {
    message: primaryMessage,
    mediaGroupMessages: messages,
    timestamp: Date.now(),
  });

  // Also write to database for session persistence
  const sessionSvc = getSessionService();
  if (sessionSvc && primaryMessage.from?.id) {
    try {
      const session = await sessionSvc.create(primaryMessage.from.id, primaryMessage);
      // Store media group messages in session
      await sessionSvc.update(session._id.toString(), {
        mediaGroupMessages: messages,
      });
      logger.debug(`Session created in DB for media group ${primaryMessage.message_id}`);
    } catch (error) {
      logger.error('Failed to create session in DB, using Map fallback:', error);
    }
  }

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

    // Clean up: Delete from both DB and Map
    const sessionSvc = getSessionService();
    if (sessionSvc) {
      try {
        // Try to find and complete session in DB (pendingKey might be session ID)
        const session = await sessionSvc.findById(pendingKey);
        if (session) {
          await sessionSvc.complete(pendingKey);
        }
      } catch (error) {
        logger.error('Error cleaning up session from DB:', error);
      }
    }
    pendingForwards.delete(pendingKey);
  } catch (error) {
    logger.error('Error scheduling transform post:', error);
    await ctx.reply('❌ Error scheduling post. Please try again.');
  }
}
