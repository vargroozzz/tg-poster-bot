import { Context, NextFunction } from 'grammy';
import type { InlineKeyboardMarkup, Message } from 'grammy/types';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { transformerService } from '../../services/transformer.service.js';
import { createChannelSelectKeyboard } from '../keyboards/channel-select.keyboard.js';
import { logger } from '../../utils/logger.js';
import { bot } from '../bot.js';
import type { MediaGroupItem, MessageContent } from '../../types/message.types.js';
import { getActivePostingChannels } from '../../database/models/posting-channel.model.js';
import { DIContainer } from '../../shared/di/container.js';
import type { SessionService } from '../../core/session/session.service.js';
import type { ISession } from '../../database/models/session.model.js';
import { SessionState } from '../../shared/constants/flow-states.js';
import { PreviewGeneratorService } from '../../core/preview/preview-generator.service.js';
import { PreviewSenderService } from '../../core/preview/preview-sender.service.js';
import { entitiesToHtml } from '../../utils/entities-to-html.js';
import { toInputRichBlocks } from '../../core/sending/rich.js';
import { config } from '../../config/index.js';
import { getUserNickname } from '../../database/models/user-nickname.model.js';
import { getNicknameKeyboard } from '../../shared/helpers/nickname.helper.js';
import {
  NICKNAME_PROMPT,
  actionPrompt,
  editNicknameKeyboard,
  knownCredit,
  showPreview,
} from './callbacks/shared.js';
import { startPublishedReply } from './callbacks/reply.js';
import { createForwardActionKeyboard } from '../keyboards/forward-action.keyboard.js';
import { transition } from '../../core/session/session-state-machine.js';
import { publishedReplyTarget } from '../../core/session/preview-route.js';

let _sessionService: SessionService | undefined;
const getSessionService = (): SessionService => {
  if (!_sessionService) {
    _sessionService = DIContainer.resolve('SessionService');
  }
  return _sessionService;
};

async function handleReplyContent(
  ctx: Context,
  message: Message,
  replySession: ISession,
  sessionSvc: SessionService,
  // An album sent as the reply: all its messages, `message` being the first.
  mediaGroupMessages?: Message[]
): Promise<void> {
  const sessionId = replySession._id.toString();

  // Only a quote of the parent's echo applies to the parent; drop one taken from any other message.
  const quotesParent =
    message.external_reply !== undefined ||
    message.reply_to_message?.message_id === replySession.replyQuoteSourceId;
  const content = quotesParent ? message : { ...message, quote: undefined };

  // A reply to a published post goes in that post's channel, in its own slot — no choices left.
  const published = publishedReplyTarget(replySession);
  if (published) {
    await sessionSvc.updateState(sessionId, SessionState.ACTION_SELECT, {
      originalMessage: content,
      mediaGroupMessages,
      messageId: message.message_id,
      chatId: message.chat.id,
      selectedChannel: published.replyToChannelId,
    });
    await promptReplyAction(ctx, sessionId, content, false, (text, other) =>
      ctx.reply(text, { ...other, reply_to_message_id: message.message_id })
    );
    return;
  }

  // Update session: set the real message, advance to CHANNEL_SELECT
  await sessionSvc.updateState(sessionId, SessionState.CHANNEL_SELECT, {
    originalMessage: content,
    mediaGroupMessages,
    messageId: message.message_id,
    chatId: message.chat.id,
  });

  const postingChannels = await getActivePostingChannels();
  if (postingChannels.length === 0) {
    await ctx.reply('⚠️ No posting channels configured. Add channels first with /addchannel.');
    return;
  }

  const keyboard = createChannelSelectKeyboard(postingChannels);
  await ctx.reply('Choose the target channel for this reply:', {
    reply_markup: keyboard,
    reply_to_message_id: message.message_id,
  });
}

/**
 * The action step of a reply. No green-list auto-forward and no Forward button: a reply can't
 * be forwarded (see forward-action.keyboard). A poll can't be transformed, so it stays
 * 'forward', is posted as a copy, and goes straight to the preview. `onControl` says whether
 * ctx's message is a live control message (button tap) the preview replaces.
 */
export async function promptReplyAction(
  ctx: Context,
  sessionId: string,
  originalMessage: Message | undefined,
  onControl: boolean,
  show: (text: string, other: { reply_markup: InlineKeyboardMarkup; parse_mode: 'HTML' }) => Promise<unknown>
): Promise<void> {
  if (originalMessage && extractMessageContent(originalMessage)?.type === 'poll') {
    await getSessionService().update(sessionId, { selectedAction: 'forward' });
    await showPreview(ctx, sessionId, onControl);
    return;
  }

  await show(actionPrompt('reply'), {
    reply_markup: createForwardActionKeyboard(undefined, true),
    parse_mode: 'HTML',
  });
}

// Store media group buffers temporarily
interface MediaGroupBuffer {
  messages: Message[];
  timeout: NodeJS.Timeout;
  ctx: Context;
}

const mediaGroupBuffers = new Map<string, MediaGroupBuffer>();

// Forwards that arrive in one burst (a multi-select forward) are buffered per user, then the
// owner chooses to post them together (one thread) or separately. Telegram drops reply links
// on forwards (external_reply is always null), so arrival time is the only grouping signal.
const BURST_WINDOW_MS = 1000;
const PENDING_BATCH_TTL_MS = 60 * 60 * 1000;
const BATCH_TOGETHER = 'batch_together';
const BATCH_SEPARATE = 'batch_separate';

interface BurstBuffer {
  messages: Message[];
  timeout: NodeJS.Timeout;
  ctx: Context;
}

// A burst of more than one post, waiting for the together/separately choice.
interface PendingBatch {
  items: Message[][];
  ctx: Context;
  createdAt: number;
}

const burstBuffers = new Map<number, BurstBuffer>();
// shortcut: in-memory, so a restart between the burst and the tap loses it; the tap then says to forward again.
const pendingBatches = new Map<string, PendingBatch>();

const mediaGroupIdOf = (m: Message): string | undefined =>
  'media_group_id' in m ? m.media_group_id : undefined;

/** Splits a burst into posts in arrival order: each album is one post, every other message its own. */
export function groupBurstItems(messages: Message[]): Message[][] {
  return messages
    .toSorted((a, b) => a.message_id - b.message_id)
    .reduce<Message[][]>((items, m) => {
      const albumId = mediaGroupIdOf(m);
      const album = albumId ? items.find((item) => mediaGroupIdOf(item[0]) === albumId) : undefined;
      return album ? items.map((item) => (item === album ? [...item, m] : item)) : [...items, [m]];
    }, []);
}

function bufferBurst(ctx: Context, message: Message, userId: number): void {
  const existing = burstBuffers.get(userId);
  if (existing) clearTimeout(existing.timeout);
  const timeout = setTimeout(() => {
    flushBurst(userId).catch(async (err) => {
      logger.error('Error processing forward burst:', err);
      await ctx.reply('❌ Error processing message. Please try again.').catch(() => {});
    });
  }, BURST_WINDOW_MS);
  burstBuffers.set(userId, { messages: [...(existing?.messages ?? []), message], timeout, ctx: existing?.ctx ?? ctx });
}

async function flushBurst(userId: number): Promise<void> {
  const buffer = burstBuffers.get(userId);
  if (!buffer) return;
  burstBuffers.delete(userId);

  const items = groupBurstItems(buffer.messages);
  logger.info(`Forward burst fired: user=${userId}, messages=${buffer.messages.length}, posts=${items.length}`);
  if (items.length <= 1) {
    await processReplyChain(buffer.ctx, buffer.messages);
    return;
  }

  // message_ids are per chat, so the user id keeps two users' batches apart.
  const batchId = `${userId}_${items[0][0].message_id}`;
  pendingBatches.set(batchId, { items, ctx: buffer.ctx, createdAt: Date.now() });
  await buffer.ctx.reply(`📦 ${items.length} posts arrived together. Post them as one batch or separately?`, {
    reply_markup: {
      inline_keyboard: [[
        { text: '📦 Together', callback_data: `${BATCH_TOGETHER}:${batchId}` },
        { text: '✂️ Separately', callback_data: `${BATCH_SEPARATE}:${batchId}` },
      ]],
    },
    reply_to_message_id: items[0][0].message_id,
  });
}

bot.callbackQuery(new RegExp(`^(${BATCH_TOGETHER}|${BATCH_SEPARATE}):(\\d+)_(\\d+)$`), async (ctx) => {
  const [, choice, ownerId, firstId] = ctx.match;
  await ctx.answerCallbackQuery();
  if (String(ctx.from.id) !== ownerId) return;
  const batchId = `${ownerId}_${firstId}`;
  const batch = pendingBatches.get(batchId);
  pendingBatches.delete(batchId); // taken once, so a double tap can't start the flows twice
  if (!batch) {
    await ctx.editMessageText('⚠️ This batch expired. Forward the messages again.').catch(() => {});
    return;
  }
  await ctx.deleteMessage().catch(() => {});
  const posts = choice === BATCH_TOGETHER ? [batch.items.flat()] : batch.items;
  // Sequential, so the channel prompts arrive in the posts' order; one failure doesn't drop the rest.
  for (const post of posts) {
    await processReplyChain(batch.ctx, post).catch(async (error: unknown) => {
      logger.error('Error processing forward batch:', error);
      await ctx.reply('❌ Error processing one of these posts. Forward it again.', {
        reply_to_message_id: post[0].message_id,
      }).catch(() => {});
    });
  }
});

setInterval(() => {
  const now = Date.now();
  pendingBatches.forEach((batch, key) => {
    if (now - batch.createdAt > PENDING_BATCH_TTL_MS) pendingBatches.delete(key);
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
    // A pending 💬 Add reply takes precedence: the user is quote-replying to the parent's echo.
    if (await sessionSvc?.findWaitingForReplyContent(userId)) return next();

    const session = await sessionSvc?.findWaitingForCustomText(userId) ?? undefined;
    if (!session || !sessionSvc) return next(); // No active session — pass through to main handler

    const customText = entitiesToHtml(message.text ?? '', message.entities);
    const foundKey = session._id.toString();

    // Typed custom text replaces the message's own text. Route it through the state machine
    // so it lands on the same step as the keyboard choices would; only the rendering differs
    // (a new message, since the user replied instead of tapping). The edit flow (/queue) walks
    // the same steps without the state machine, so it repeats them below.
    if (session.state === SessionState.TEXT_HANDLING && session.originalMessage) {
      const { newState, step, sessionUpdates } = transition(session.state, {
        type: 'TEXT_CHOSEN',
        handling: 'remove',
        text: customText,
        knownNicknameUserId: await knownCredit(ctx, session, session.originalMessage),
      });
      await sessionSvc.updateState(foundKey, newState, { ...sessionUpdates, waitingForCustomText: false });

      if (step.type === 'show_nickname_select') {
        await ctx.reply(NICKNAME_PROMPT, {
          reply_parameters: { message_id: session.messageId },
          reply_markup: await getNicknameKeyboard(),
        });
        return;
      }
    } else if (session.editingPostId) {
      const nicknameKeyboard = await editNicknameKeyboard(foundKey);
      const updates = { customText, textHandling: 'remove' as const, waitingForCustomText: false };

      if (nicknameKeyboard) {
        await sessionSvc.updateState(foundKey, SessionState.NICKNAME_SELECT, updates);
        await ctx.reply(NICKNAME_PROMPT, { reply_markup: nicknameKeyboard });
        return;
      }
      await sessionSvc.updateState(foundKey, SessionState.PREVIEW, updates);
    } else {
      await sessionSvc.updateState(foundKey, SessionState.PREVIEW, {
        customText,
        waitingForCustomText: false,
      });
    }

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
bot.on([
  'message:forward_origin', 'message:photo', 'message:video', 'message:document', 'message:animation',
  'message:voice', 'message:audio', 'message:video_note', 'message:sticker', 'message:dice',
  'message:contact', 'message:location', 'message:venue', 'message:text', 'message:poll',
  'message:rich_message',
], async (ctx: Context) => {
  try {
    const message = ctx.message;

    if (!message) {
      return;
    }

    const forwardOrigin = message.forward_origin;
    const userId = ctx.from?.id;

    // Non-owner proposers must set a nickname before proposing anything.
    if (userId && userId !== config.authorizedUserId) {
      const proposerNickname = await getUserNickname(userId);
      if (!proposerNickname) {
        await ctx.reply('👋 To propose a post, first set your nickname:\n/setnickname <name>');
        return;
      }
    }

    // Forwards (albums included) are buffered by arrival time; see bufferBurst.
    if (forwardOrigin && userId) {
      bufferBurst(ctx, message, userId);
      return;
    }

    const mediaGroupId = 'media_group_id' in message ? message.media_group_id : undefined;
    if (mediaGroupId) {
      // Non-forwarded album: wait for all its items.
      const buffer = mediaGroupBuffers.get(mediaGroupId);
      if (buffer) clearTimeout(buffer.timeout);
      const timeout = setTimeout(() => {
        processMediaGroup(mediaGroupId).catch((error) => {
          logger.error('Error processing media group:', error);
        });
      }, 1000);
      mediaGroupBuffers.set(mediaGroupId, {
        messages: [...(buffer?.messages ?? []), message],
        timeout,
        ctx: buffer?.ctx ?? ctx,
      });
      return;
    }

    // Non-forwarded message: process immediately
    await processSingleMessage(ctx, message);
  } catch (error) {
    logger.error('Error handling message:', error);
    await ctx.reply('❌ Error processing message. Please try again.');
  }
});

/**
 * Hands a message or album to a reply session waiting for content, before anything starts a new
 * standalone session from it. Returns whether one took it.
 */
async function takeAsReplyContent(ctx: Context, messages: Message[]): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  const sessionSvc = getSessionService();
  const replySession = await sessionSvc.findWaitingForReplyContent(userId).catch((error: unknown) => {
    logger.error('Error checking for reply session:', error);
    return null; // fall through to normal processing
  });
  if (!replySession) return false;
  // Webhook updates can arrive out of order; the album's first item carries the reply/quote.
  const sorted = messages.toSorted((a, b) => a.message_id - b.message_id);
  try {
    await handleReplyContent(ctx, sorted[0], replySession, sessionSvc, sorted.length > 1 ? sorted : undefined);
  } catch (error) {
    // The session may already own this message; starting a post from it too would collide.
    logger.error('Error taking reply content:', error);
    await ctx.reply('❌ Something went wrong with this reply. Start it again.').catch(() => {});
  }
  return true;
}

async function processSingleMessage(ctx: Context, message: Message) {
  // A pasted link to a post in a posting channel starts a reply to that published post. It
  // replaces a reply still waiting for content: an abandoned 💬 Add reply lives for a day and
  // would otherwise swallow the link as text, while the bot's answer here says what happened.
  // A throw here comes before the link is recognised: fall through to normal processing.
  const tookLink = await startPublishedReply(ctx, message).catch((error: unknown) => {
    logger.error('Error starting a published-post reply:', error);
    return false;
  });
  if (tookLink) return;

  if (await takeAsReplyContent(ctx, [message])) return;

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
  const keyboard = createChannelSelectKeyboard(postingChannels);

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

  await ctx.reply(`📍 Select target channel for this post:${greenListNote}`, {
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

  if (await takeAsReplyContent(buffer.ctx, messages)) return;

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
  const keyboard = createChannelSelectKeyboard(postingChannels);

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

/** Starts the flow for forwarded messages: one message, one album, or several as one thread. */
async function processReplyChain(ctx: Context, unsorted: Message[]) {
  if (unsorted.length === 0) return;

  // Sort by message_id for chronological order before any analysis
  const messages = unsorted.toSorted((a, b) => a.message_id - b.message_id);
  const primaryMessage = messages[0];

  const items = groupBurstItems(messages);
  const itemCount = items.length;
  const isPureAlbum = itemCount === 1 && mediaGroupIdOf(primaryMessage) !== undefined;

  logger.info(`Forward flow: primary=${primaryMessage.message_id}, messages=${messages.length}, items=${itemCount}, isPureAlbum=${isPureAlbum}`);

  // Single non-album message: use existing single-message flow unchanged
  if (messages.length === 1 && !mediaGroupIdOf(primaryMessage)) {
    await processSingleMessage(ctx, messages[0]);
    return;
  }

  // ponytail: only a forwarded album can be reply content; a forwarded thread still starts a
  // post, since a reply holds one post's content. Route threads too if that's ever wanted.
  if (isPureAlbum && (await takeAsReplyContent(ctx, messages))) return;

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
      if (isPureAlbum) {
        // Standalone forwarded album: store as mediaGroupMessages (same as non-forwarded albums)
        await sessionSvc.update(sessionId, { mediaGroupMessages: messages });
      } else {
        // Multi-item thread: store all messages for bulk forwarding
        await sessionSvc.update(sessionId, { replyChainMessages: messages });
      }
    } catch (err) {
      logger.error('Failed to create session for reply chain:', err);
    }
  }

  // Build channel selection keyboard
  const keyboard = createChannelSelectKeyboard(postingChannels);

  const promptText = isPureAlbum
    ? `📍 Select target channel for this album (${messages.length} items):`
    : `📍 Select target channel for this thread (${itemCount} posts):`;

  await ctx.reply(promptText, {
    reply_markup: keyboard,
    reply_to_message_id: primaryMessage.message_id,
  });
}

const captionHtml = (message: Message): string | undefined =>
  message.caption ? entitiesToHtml(message.caption, message.caption_entities) : undefined;

const mediaGroupItem = (msg: Message): MediaGroupItem | undefined => {
  const spoiler = { hasSpoiler: msg.has_media_spoiler ?? undefined };
  if (msg.photo?.length) {
    return { type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id, ...spoiler };
  }
  if (msg.video) return { type: 'video', fileId: msg.video.file_id, ...spoiler };
  if (msg.audio) return { type: 'audio', fileId: msg.audio.file_id };
  if (msg.document) return { type: 'document', fileId: msg.document.file_id };
  return undefined;
};

// Ordered: the first match wins, because Telegram messages overlap — an animation also
// carries `document`, a venue also carries `location`, media always outranks its caption.
const SINGLE_EXTRACTORS: ReadonlyArray<(m: Message) => MessageContent | undefined> = [
  m => m.photo?.length
    ? { type: 'photo', fileId: m.photo[m.photo.length - 1].file_id, hasSpoiler: m.has_media_spoiler ?? undefined, text: captionHtml(m) }
    : undefined,
  m => m.animation && { type: 'animation', fileId: m.animation.file_id, hasSpoiler: m.has_media_spoiler ?? undefined, text: captionHtml(m) },
  m => m.video && { type: 'video', fileId: m.video.file_id, hasSpoiler: m.has_media_spoiler ?? undefined, text: captionHtml(m) },
  m => m.video_note && { type: 'video_note', fileId: m.video_note.file_id },
  m => m.voice && { type: 'voice', fileId: m.voice.file_id, text: captionHtml(m) },
  m => m.audio && { type: 'audio', fileId: m.audio.file_id, text: captionHtml(m) },
  m => m.sticker && { type: 'sticker', fileId: m.sticker.file_id },
  m => m.document && { type: 'document', fileId: m.document.file_id, text: captionHtml(m) },
  m => m.dice && { type: 'dice', emoji: m.dice.emoji },
  m => m.contact && {
    type: 'contact',
    phoneNumber: m.contact.phone_number,
    firstName: m.contact.first_name,
    lastName: m.contact.last_name,
    vcard: m.contact.vcard,
  },
  m => m.venue && {
    type: 'venue',
    latitude: m.venue.location.latitude,
    longitude: m.venue.location.longitude,
    title: m.venue.title,
    address: m.venue.address,
  },
  m => m.location && { type: 'location', latitude: m.location.latitude, longitude: m.location.longitude },
  m => m.poll && { type: 'poll' },
  m => m.rich_message && { type: 'rich', blocks: toInputRichBlocks(m.rich_message.blocks) },
  m => m.text
    ? { type: 'text', text: entitiesToHtml(m.text, m.entities), linkPreviewOptions: m.link_preview_options ?? { is_disabled: true } }
    : undefined,
];

export function extractMessageContent(
  message: Message,
  mediaGroupMessages?: Message[]
): MessageContent | null {
  // If media group messages provided, create media group content
  if (mediaGroupMessages && mediaGroupMessages.length > 1) {
    const mediaItems = mediaGroupMessages.flatMap((msg) => mediaGroupItem(msg) ?? []);

    const captionMsg = mediaGroupMessages.find((msg) => msg.caption);
    const caption = captionMsg ? captionHtml(captionMsg) : undefined;

    if (mediaItems.length > 0) {
      return { type: 'media_group', mediaGroup: mediaItems, text: caption };
    }
  }

  return SINGLE_EXTRACTORS.map((extract) => extract(message)).find((content) => content !== undefined) ?? null;
}

