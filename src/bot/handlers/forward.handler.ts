import { Context } from 'grammy';
import { Message } from 'grammy/types';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { transformerService } from '../../services/transformer.service.js';
import { createChannelSelectKeyboard } from '../keyboards/channel-select.keyboard.js';
import { logger } from '../../utils/logger.js';
import { bot } from '../bot.js';
import type { MessageContent } from '../../types/message.types.js';
import { getActivePostingChannels } from '../../database/models/posting-channel.model.js';
import { DIContainer } from '../../shared/di/container.js';
import type { SessionService } from '../../core/session/session.service.js';
import { SessionState } from '../../shared/constants/flow-states.js';
import { PreviewGeneratorService } from '../../core/preview/preview-generator.service.js';
import { PreviewSenderService } from '../../core/preview/preview-sender.service.js';
import { entitiesToHtml } from '../../utils/entities-to-html.js';

// Get SessionService from DI container (will be initialized in index.ts)
let sessionService: SessionService;
const getSessionService = () => {
  if (!sessionService && DIContainer.has('SessionService')) {
    sessionService = DIContainer.resolve<SessionService>('SessionService');
  }
  return sessionService;
};

// Store media group buffers temporarily
interface MediaGroupBuffer {
  messages: Message[];
  timeout: NodeJS.Timeout;
}

const mediaGroupBuffers = new Map<string, MediaGroupBuffer>();

// Store reply chain buffers temporarily
interface ReplyChainBuffer {
  messages: Message[];
  timeout: NodeJS.Timeout;
  // ctx is stored here to support the single-message fallback path (processSingleMessage
  // requires a full Grammy Context). Stale entries are cleaned by the periodic interval
  // below, so this does not cause a long-lived memory leak.
  ctx: Context;
  createdAt: number; // epoch ms — used by periodic cleanup
}

const replyChainBuffers = new Map<string, ReplyChainBuffer>();

// Clean up stale reply-chain buffers every 5 minutes
setInterval(() => {
  const now = Date.now();
  const replyChainTtl = 5 * 60 * 1000; // 5 minutes
  replyChainBuffers.forEach((buffer, key) => {
    if (now - buffer.createdAt > replyChainTtl) {
      clearTimeout(buffer.timeout);
      replyChainBuffers.delete(key);
      logger.debug(`Cleaned up stale reply chain buffer: ${key}`);
    }
  });
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

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findWaitingForCustomText(userId) ?? undefined;
    if (!session || !sessionSvc) return;

    const customText = entitiesToHtml(message.text ?? '', message.entities);
    const foundKey = session._id.toString();

    await sessionSvc.updateState(foundKey, SessionState.PREVIEW, {
      customText,
      waitingForCustomText: false,
    });

    const updatedSession = await sessionSvc.findById(foundKey);
    if (!updatedSession) {
      await ctx.reply('⚠️ Session not found. Please try again.');
      return;
    }

    const previewGenerator = new PreviewGeneratorService();
    const previewContent = await previewGenerator.generatePreview(updatedSession);

    const previewSender = new PreviewSenderService(ctx.api);
    const previewMessageId = await previewSender.sendPreview(userId, previewContent, foundKey);

    await sessionSvc.update(foundKey, { previewMessageId });
    logger.debug(`Preview shown after custom text for session ${foundKey}`);
  } catch (error) {
    logger.error('Error handling custom text input:', error);
  }
});

// Handle both forwarded and non-forwarded messages
bot.on(['message:forward_origin', 'message:photo', 'message:video', 'message:document', 'message:animation', 'message:text', 'message:poll'], async (ctx: Context) => {
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
    // Group forwarded messages from the same source chat arriving within 1 second.
    // When the user batch-forwards a thread, messages arrive independently with no
    // reply_to_message link — the only shared identifier is the source chat ID.
    const forwardOrigin = message.forward_origin;
    const sourceChatId =
      forwardOrigin?.type === 'channel'
        ? String(forwardOrigin.chat.id)
        : forwardOrigin?.type === 'chat'
          ? String(forwardOrigin.sender_chat.id)
          : undefined;
    const userId = ctx.from?.id;

    if (sourceChatId && userId) {
      const batchKey = `${userId}_${sourceChatId}`;
      const buffer = replyChainBuffers.get(batchKey);

      if (buffer) {
        buffer.messages.push(message);
        clearTimeout(buffer.timeout);
        buffer.timeout = setTimeout(() => {
          processReplyChain(batchKey).catch((err) => {
            logger.error('Error processing forward batch:', err);
          });
        }, 1000);
      } else {
        const timeout = setTimeout(() => {
          processReplyChain(batchKey).catch((err) => {
            logger.error('Error processing forward batch:', err);
          });
        }, 1000);
        replyChainBuffers.set(batchKey, {
          messages: [message],
          timeout,
          ctx,
          createdAt: Date.now(),
        });
      }
    } else {
      // Non-forwarded or user-forwarded message: process immediately
      await processSingleMessage(ctx, message);
    }
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

  if (sessionSvc && ctx.from?.id) {
    try {
      await sessionSvc.create(ctx.from.id, message);
      logger.debug(`Session created in DB for message ${message.message_id}`);
    } catch (error) {
      logger.error('Failed to create session in DB:', error);
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

  const sessionSvc = getSessionService();
  if (sessionSvc && primaryMessage.from?.id) {
    try {
      const session = await sessionSvc.create(primaryMessage.from.id, primaryMessage);
      await sessionSvc.update(session._id.toString(), {
        mediaGroupMessages: messages,
      });
      logger.debug(`Session created in DB for media group ${primaryMessage.message_id}`);
    } catch (error) {
      logger.error('Failed to create session in DB:', error);
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

async function processReplyChain(bufferKey: string) {
  const buffer = replyChainBuffers.get(bufferKey);
  if (!buffer) return;

  clearTimeout(buffer.timeout);
  replyChainBuffers.delete(bufferKey);

  const { messages, ctx } = buffer;
  if (messages.length === 0) return;

  // If only one message ended up in the buffer, treat as single message
  if (messages.length === 1) {
    await processSingleMessage(ctx, messages[0]);
    return;
  }

  // Sort by message_id for chronological order
  messages.sort((a, b) => a.message_id - b.message_id);
  const primaryMessage = messages[0];

  // Get available posting channels
  const postingChannels = await getActivePostingChannels();
  if (postingChannels.length === 0) {
    await ctx.reply(
      '⚠️ No posting channels configured.\n\nPlease add channels first using /addchannel command.'
    );
    return;
  }

  // Idempotency check using primary message
  const sessionSvc = getSessionService();
  if (sessionSvc && ctx.from?.id) {
    try {
      const existing = await sessionSvc.findByMessage(ctx.from.id, primaryMessage.message_id);
      if (existing) {
        logger.debug(`Session already exists for reply chain primary message ${primaryMessage.message_id}, skipping`);
        return;
      }
    } catch (err) {
      logger.error('Error checking idempotency for reply chain:', err);
    }
  }

  // Create session for primary message
  let sessionId: string | undefined;
  if (sessionSvc && ctx.from?.id) {
    try {
      const session = await sessionSvc.create(ctx.from.id, primaryMessage);
      sessionId = session._id.toString();
      // Store reply chain messages and pre-select forward action
      await sessionSvc.update(sessionId, {
        replyChainMessages: messages,
        selectedAction: 'forward',
      });
      logger.debug(`Session ${sessionId} created for reply chain of ${messages.length} messages`);
    } catch (err) {
      logger.error('Failed to create session for reply chain:', err);
    }
  }

  // Build channel selection keyboard
  const channels = postingChannels.map((ch) => ({
    id: ch.channelId,
    title: ch.channelTitle ?? ch.channelId,
    username: ch.channelUsername,
  }));
  const keyboard = createChannelSelectKeyboard(channels);

  await ctx.reply(
    `📍 Select target channel for this thread (${messages.length} messages):`,
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
    const mediaItems = mediaGroupMessages.flatMap((msg): Array<{ type: 'photo' | 'video'; fileId: string }> => {
      if ('photo' in msg && msg.photo && msg.photo.length > 0) {
        return [{ type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id }];
      }
      if ('video' in msg && msg.video) {
        return [{ type: 'video', fileId: msg.video.file_id }];
      }
      return [];
    });

    const caption = mediaGroupMessages.find((msg) => msg.caption)?.caption;

    if (mediaItems.length > 0) {
      return { type: 'media_group', mediaGroup: mediaItems, text: caption };
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

  if ('poll' in message && message.poll) {
    return { type: 'poll' };
  }

  return null;
}

