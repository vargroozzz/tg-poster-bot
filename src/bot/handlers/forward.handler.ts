import { Context, NextFunction } from 'grammy';
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
  ctx: Context;
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

// Maps a forwarded message_id (in bot chat) to its buffer key, so that
// subsequent messages replying to it can be linked to the same buffer.
const forwardedMsgToBufferKey = new Map<number, string>();

// Clean up stale reply-chain buffers every 5 minutes
setInterval(() => {
  const now = Date.now();
  const replyChainTtl = 5 * 60 * 1000; // 5 minutes
  replyChainBuffers.forEach((buffer, key) => {
    if (now - buffer.createdAt > replyChainTtl) {
      clearTimeout(buffer.timeout);
      buffer.messages.forEach((msg) => forwardedMsgToBufferKey.delete(msg.message_id));
      replyChainBuffers.delete(key);
      logger.debug(`Cleaned up stale reply chain buffer: ${key}`);
    }
  });
}, 5 * 60 * 1000);

// Handle text messages when waiting for custom text input.
// Only match messages that are replies but NOT external_reply — external_reply means the user is
// replying to a message in a different chat (cross-chat reply), which is content to schedule, not
// custom text input. Those fall through to the main handler registered on 'message:text' below.
bot.on('message:text').filter(
  (ctx) => !!ctx.message?.reply_to_message && !ctx.message?.external_reply,
  async (ctx: Context, next: NextFunction) => {
  try {
    const message = ctx.message;

    if (!message) {
      return next();
    }

    // Check if this is a reply to a text message (our custom text prompt)
    const replyToMessage = message.reply_to_message;
    if (!replyToMessage || !('text' in replyToMessage)) {
      return next(); // Not replying to text message — pass through to main handler
    }

    const userId = ctx.from?.id;
    if (!userId) {
      return next();
    }

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findWaitingForCustomText(userId) ?? undefined;
    if (!session || !sessionSvc) return next(); // No active session — pass through to main handler

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
    logger.info(`[RC-DEBUG] handler received: id=${message.message_id}, type=${Object.keys(message).filter(k => ['text','photo','video','document','animation','poll'].includes(k))[0] ?? 'other'}, mediaGroupId=${mediaGroupId ?? 'none'}, forwardType=${message.forward_origin?.type ?? 'none'}`);

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
          ctx,
        });
      }

      // Register this message ID so that thread comments arriving later can
      // find and join the same media group buffer.
      forwardedMsgToBufferKey.set(message.message_id, `mg:${mediaGroupId}`);

      return; // Don't process yet
    }

    // Single message (not part of media group)
    // Group forwarded messages that form a thread using reply-chain linkage.
    // When Telegram batch-forwards a thread, the forwarded copies preserve reply
    // relationships using the new message IDs in the bot chat. We track each
    // forwarded message_id → bufferKey so that a reply arriving later can join
    // the same buffer rather than starting a new one.
    const forwardOrigin = message.forward_origin;
    const userId = ctx.from?.id;
    logger.info(`[RC-DEBUG] incoming msg: id=${message.message_id}, forwardType=${forwardOrigin?.type ?? 'none'}`);

    if (forwardOrigin && userId) {
      // If this message is a reply to one we already buffered, reuse that buffer.
      const replyToId = message.reply_to_message?.message_id;
      const linkedKey = replyToId !== undefined ? forwardedMsgToBufferKey.get(replyToId) : undefined;

      // If this message is a comment/reply to a media group, merge both into one thread buffer.
      if (linkedKey?.startsWith('mg:')) {
        const mediaGroupId = linkedKey.slice(3);
        const mgBuffer = mediaGroupBuffers.get(mediaGroupId);

        if (mgBuffer) {
          clearTimeout(mgBuffer.timeout);
          mediaGroupBuffers.delete(mediaGroupId);

          // Combined key anchored on the first media group message.
          const combinedKey = `fwd_${userId}_${mgBuffer.messages[0].message_id}`;
          const allMessages = [...mgBuffer.messages, message];

          // Re-register all IDs so further comments join the same buffer.
          allMessages.forEach((msg) => forwardedMsgToBufferKey.set(msg.message_id, combinedKey));

          const timeout = setTimeout(() => {
            processReplyChain(combinedKey).catch((err) => {
              logger.error('Error processing forward batch:', err);
            });
          }, 1000);

          replyChainBuffers.set(combinedKey, {
            messages: allMessages,
            timeout,
            ctx: mgBuffer.ctx,
            createdAt: Date.now(),
          });

          return;
        }
        // mgBuffer already flushed — fall through to normal reply-chain logic
      }

      // Use the linked key only when it's an actual reply-chain key; an mg: key
      // at this point means the media group was already flushed, so start fresh.
      const batchKey = linkedKey && !linkedKey.startsWith('mg:')
        ? linkedKey
        : `fwd_${userId}_${message.message_id}`;

      // Register so future replies to this message can find the same buffer.
      forwardedMsgToBufferKey.set(message.message_id, batchKey);

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
      // Non-forwarded message: process immediately
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

  // Remove forwardedMsgToBufferKey entries for this media group.
  messages.forEach((msg) => forwardedMsgToBufferKey.delete(msg.message_id));

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
  buffer.messages.forEach((msg) => forwardedMsgToBufferKey.delete(msg.message_id));

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
      const updatedSession = await sessionSvc.update(sessionId, {
        replyChainMessages: messages,
        selectedAction: 'forward',
      });
      logger.info(`[RC-DEBUG] session created: id=${sessionId}, messageCount=${messages.length}, ids=[${messages.map((m) => m.message_id).join(',')}], updateResult=${updatedSession ? `ok(${updatedSession.replyChainMessages?.length})` : 'null'}`);
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
    const mediaItems = mediaGroupMessages.flatMap((msg): Array<{ type: 'photo' | 'video'; fileId: string; hasSpoiler?: boolean }> => {
      if ('photo' in msg && msg.photo && msg.photo.length > 0) {
        return [{ type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id, hasSpoiler: msg.has_media_spoiler ?? undefined }];
      }
      if ('video' in msg && msg.video) {
        return [{ type: 'video', fileId: msg.video.file_id, hasSpoiler: msg.has_media_spoiler ?? undefined }];
      }
      return [];
    });

    const captionMsg = mediaGroupMessages.find((msg) => msg.caption);
    const caption = captionMsg?.caption
      ? entitiesToHtml(captionMsg.caption, captionMsg.caption_entities)
      : undefined;

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
      hasSpoiler: message.has_media_spoiler ?? undefined,
      text: message.caption ? entitiesToHtml(message.caption, message.caption_entities) : undefined,
    };
  }

  if ('video' in message && message.video) {
    return {
      type: 'video',
      fileId: message.video.file_id,
      hasSpoiler: message.has_media_spoiler ?? undefined,
      text: message.caption ? entitiesToHtml(message.caption, message.caption_entities) : undefined,
    };
  }

  if ('document' in message && message.document) {
    return {
      type: 'document',
      fileId: message.document.file_id,
      text: message.caption ? entitiesToHtml(message.caption, message.caption_entities) : undefined,
    };
  }

  if ('animation' in message && message.animation) {
    return {
      type: 'animation',
      fileId: message.animation.file_id,
      text: message.caption ? entitiesToHtml(message.caption, message.caption_entities) : undefined,
    };
  }

  if ('text' in message && message.text) {
    return {
      type: 'text',
      text: entitiesToHtml(message.text, message.entities),
      linkPreviewOptions: message.link_preview_options ?? { is_disabled: true },
    };
  }

  if ('poll' in message && message.poll) {
    return { type: 'poll' };
  }

  return null;
}

