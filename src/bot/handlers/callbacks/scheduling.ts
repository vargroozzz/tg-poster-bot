// src/bot/handlers/callbacks/scheduling.ts
import { Context } from 'grammy';
import type { Message } from 'grammy/types';
import { bot } from '../../bot.js';
import { parseForwardInfo } from '../../../utils/message-parser.js';
import { transformerService } from '../../../services/transformer.service.js';
import { extractMessageContent } from '../forward.handler.js';
import { createForwardActionKeyboard } from '../../keyboards/forward-action.keyboard.js';
import { createChannelSelectKeyboard } from '../../keyboards/channel-select.keyboard.js';
import { createEditChannelSelectKeyboard } from '../../keyboards/edit-keyboards.js';
import { createReplySlotKeyboard } from '../../keyboards/reply-slot.keyboard.js';
import { createAddReplyKeyboard } from '../../keyboards/preview-action.keyboard.js';
import type { EmbeddedReplyData } from '../../../database/models/scheduled-post.model.js';
import { CustomTextPreset } from '../../../database/models/custom-text-preset.model.js';
import { formatSlotTime } from '../../../utils/time-slots.js';
import { logger } from '../../../utils/logger.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { NICKNAME_NONE_KEY } from '../../keyboards/nickname-select.keyboard.js';
import { findNicknameByUserId } from '../../../shared/helpers/nickname.helper.js';
import { channelLabel, toChannelInfo } from '../../../shared/helpers/channel.helper.js';
import { PostSchedulerService } from '../../../core/posting/post-scheduler.service.js';
import { SessionState } from '../../../shared/constants/flow-states.js';
import type { FlowEvent } from '../../../shared/constants/flow-states.js';
import { transition } from '../../../core/session/session-state-machine.js';
import { classifyScheduleConfirm } from '../../../core/session/preview-route.js';
import type { ScheduleRoute } from '../../../core/session/preview-route.js';
import { PostingChannel, getActivePostingChannels } from '../../../database/models/posting-channel.model.js';
import { ScheduledPostRepository } from '../../../database/repositories/scheduled-post.repository.js';
import { QueueService } from '../../../core/queue/queue.service.js';
import type { ISession } from '../../../database/models/session.model.js';
import {
  getSessionService,
  deletePreviewMessages,
  showPreview,
  renderStep,
  computeIsPlainText,
  resolveKnownNicknameUserId,
} from './shared.js';

const postScheduler = new PostSchedulerService();
const queueService = new QueueService();

async function getPendingForward(userId: number, messageId: number): Promise<ISession | undefined> {
  const sessionSvc = getSessionService();
  if (!sessionSvc) return undefined;
  try {
    const session = await sessionSvc.findByMessage(userId, messageId);
    if (session) logger.debug(`Found session in DB for message ${messageId}`);
    return session ?? undefined;
  } catch (error) {
    logger.error('Error fetching session from DB:', error);
    return undefined;
  }
}

// Every event-dispatching callback shares the same shell: ack, find the original
// message and its session, build a FlowEvent, then run the transition + render.
// `match` is grammy's regex capture for this callback (undefined for plain-string
// filters). The builder returns null when it already handled the response
// (self-loops, validation errors).
type Dispatch = {
  ctx: Context;
  session: ISession;
  originalMessage: Message;
  match: RegExpMatchArray | undefined;
};

function transitionCallback(
  fallbackMessage: string,
  errorLog: string,
  buildEvent: (d: Dispatch) => Promise<FlowEvent | null> | FlowEvent | null
): (ctx: Context) => Promise<void> {
  return async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const originalMessage = ctx.callbackQuery?.message?.reply_to_message;
      if (!originalMessage) {
        await ErrorMessages.originalMessageNotFound(ctx);
        return;
      }

      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      const match = Array.isArray(ctx.match) ? ctx.match : undefined;
      const event = await buildEvent({ ctx, session, originalMessage, match });
      if (!event) return;

      const key = session._id.toString();
      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(key, newState, sessionUpdates);
      await renderStep(ctx, step, key);
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, fallbackMessage, errorLog);
    }
  };
}

// Resolved context shared by every preview:* handler.
type Confirm = {
  ctx: Context;
  session: ISession;
  sessionKey: string;
  sessionSvc: ReturnType<typeof getSessionService>;
  fromId: number | undefined;
};

// The preview:* callbacks (schedule/cancel/back) key off a sessionId in the
// callback data rather than the original message, so they share a different
// shell: ack, pull sessionKey from the regex, load the session by id.
function previewCallback(
  fallbackMessage: string,
  errorLog: string,
  handler: (d: Confirm) => Promise<void>
): (ctx: Context) => Promise<void> {
  return async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const sessionKey = Array.isArray(ctx.match) ? ctx.match[1] : undefined;
      if (!sessionKey) {
        await ctx.reply('Invalid session.');
        return;
      }

      const sessionSvc = getSessionService();
      const session = await sessionSvc.findById(sessionKey);
      if (!session) {
        await ctx.reply('Session expired. Please forward the message again.');
        return;
      }

      await handler({ ctx, session, sessionKey, sessionSvc, fromId: ctx.from?.id });
    } catch (error) {
      await ErrorMessages.catchAndReply(ctx, error, fallbackMessage, errorLog);
    }
  };
}

// Delete the preview message(s) and the control message. Shared by the confirm
// flow (finalizePreview) and the cancel/back flows, which close the session out
// at different points.
async function teardownPreviewMessages({ ctx, session, fromId }: Confirm): Promise<void> {
  if (fromId) await deletePreviewMessages(ctx, fromId, session);
  await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
}

// Tear down the preview + control messages and close out the session.
async function finalizePreview(c: Confirm): Promise<void> {
  await teardownPreviewMessages(c);
  await c.sessionSvc.complete(c.sessionKey);
}

async function channelLabelById(channelId: string): Promise<string> {
  const doc = await PostingChannel.findOne({ channelId }).lean();
  return channelLabel(doc ?? { channelId });
}

// ── preview:schedule, one function per route (see classifyScheduleConfirm) ──

async function confirmEdit(c: Confirm, route: ScheduleRoute): Promise<void> {
  const { ctx, session, sessionKey } = c;
  const {
    editingPostId,
    editingOriginalChannelId,
    editingOriginalScheduledTime,
    editingRawContent,
    editingOriginalForward,
  } = session;

  // Inline guard also narrows the optional editing* fields for the rest of the body.
  if (!editingPostId || !editingRawContent || !editingOriginalForward || !editingOriginalScheduledTime || !editingOriginalChannelId) {
    await ctx.reply('❌ Edit session is corrupted. Please start over.');
    return;
  }

  const repository = new ScheduledPostRepository();

  if (route === 'edit-same-channel') {
    let newContent = editingRawContent;
    if (session.selectedAction === 'transform') {
      const selectedNickname = session.selectedUserId
        ? await findNicknameByUserId(session.selectedUserId)
        : null;
      newContent = await transformerService.transformContent(
        editingRawContent,
        editingOriginalForward,
        'transform',
        session.textHandling ?? 'keep',
        selectedNickname,
        session.customText
      );
    }

    const updated = await repository.updatePost(editingPostId, {
      content: newContent,
      action: session.selectedAction ?? 'transform',
      rawContent: editingRawContent,
      textHandling: session.textHandling,
      selectedUserId: session.selectedUserId,
      customText: session.customText,
    });

    await finalizePreview(c);

    if (!updated) {
      await ctx.reply('⚠️ Post was already published — your changes were not applied.');
      return;
    }

    await ctx.reply(
      `✅ Post updated!\nTarget: ${await channelLabelById(editingOriginalChannelId)}\nScheduled for: ${formatSlotTime(editingOriginalScheduledTime)}`
    );
  } else {
    await queueService.deleteAndCascade(editingPostId);

    const newChannelId = session.selectedChannel ?? editingOriginalChannelId;
    const { scheduledTime } =
      session.selectedAction === 'forward'
        ? await postScheduler.scheduleForwardPost({
            targetChannelId: newChannelId,
            forwardInfo: editingOriginalForward,
            content: editingRawContent,
          })
        : await postScheduler.scheduleTransformPost({
            targetChannelId: newChannelId,
            forwardInfo: editingOriginalForward,
            content: editingRawContent,
            textHandling: session.textHandling ?? 'keep',
            selectedUserId: session.selectedUserId,
            customText: session.customText,
          });

    await finalizePreview(c);

    await ctx.reply(
      `✅ Moved to ${await channelLabelById(newChannelId)}\nScheduled for: ${formatSlotTime(scheduledTime)}`
    );
  }

  logger.info(`Edit confirmed for session ${sessionKey}`);
}

async function confirmReply(c: Confirm, route: ScheduleRoute): Promise<void> {
  const { ctx, session } = c;

  const replyOriginalMessage = session.originalMessage;
  if (!replyOriginalMessage) {
    await ctx.reply('Reply session is corrupted. Please start over.');
    return;
  }

  const replySelectedChannel = session.selectedChannel;
  if (!replySelectedChannel) {
    await ctx.reply('No channel selected for reply.');
    return;
  }

  // Routing guarantees this; the guard just narrows it for TypeScript.
  const parentPostId = session.replyParentPostId;
  if (!parentPostId) {
    await ctx.reply('Reply session is corrupted. Please start over.');
    return;
  }

  const repository = new ScheduledPostRepository();
  const parentPost = await repository.findById(parentPostId);

  const replyForwardInfo = parseForwardInfo(replyOriginalMessage);
  const replyMediaGroupMessages = session.mediaGroupMessages;
  if (replyMediaGroupMessages && replyMediaGroupMessages.length > 1) {
    replyForwardInfo.mediaGroupMessageIds = replyMediaGroupMessages.map((m) => m.message_id);
  }

  const replyContent = extractMessageContent(replyOriginalMessage, replyMediaGroupMessages);
  if (!replyContent) {
    await ctx.reply('Unsupported reply content type.');
    return;
  }

  const {
    textHandling: replyTextHandling = 'keep',
    selectedUserId: replyUserId,
    customText: replyCustomText,
    selectedAction: replyAction = 'transform',
  } = session;

  if (route === 'reply-together') {
    const replyNickname = replyUserId ? await findNicknameByUserId(replyUserId) : null;
    const transformedReplyContent =
      replyAction === 'transform'
        ? await transformerService.transformContent(
            replyContent,
            replyForwardInfo,
            'transform',
            replyTextHandling,
            replyNickname,
            replyCustomText
          )
        : { ...replyContent, text: replyContent.text ?? '' };

    const replyData: EmbeddedReplyData = {
      targetChannelId: replySelectedChannel,
      content: transformedReplyContent,
      rawContent: replyContent,
      action: replyAction,
      textHandling: replyTextHandling,
      selectedUserId: replyUserId ?? null,
      customText: replyCustomText,
      originalForward: replyForwardInfo,
    };

    const attached = await repository.attachEmbeddedReply(parentPostId, replyData);

    await finalizePreview(c);

    if (!attached) {
      await ctx.reply('⚠️ Parent post was already published — reply could not be attached.');
      return;
    }

    const parentSlotTime = parentPost?.scheduledTime;
    await ctx.reply(
      `↩️ Reply scheduled with the parent post${parentSlotTime ? ` at ${formatSlotTime(parentSlotTime)}` : ''}`
    );
    logger.info(`Together reply attached to parent post ${parentPostId}`);
    return;
  }

  // Separated reply: schedule normally, then convert to separated reply
  const baseReplyParams = {
    targetChannelId: replySelectedChannel,
    originalMessage: replyOriginalMessage,
    forwardInfo: replyForwardInfo,
    content: replyContent,
  };

  const { scheduledTime: replySlotTime, postId: replyPostId } =
    replyAction === 'forward'
      ? await postScheduler.scheduleForwardPost(baseReplyParams)
      : await postScheduler.scheduleTransformPost({
          ...baseReplyParams,
          textHandling: replyTextHandling,
          selectedUserId: replyUserId,
          customText: replyCustomText,
        });

  await repository.convertToSeparatedReply(replyPostId, parentPostId, parentPost ?? null);

  await finalizePreview(c);

  await ctx.reply(`↩️ Reply scheduled for ${formatSlotTime(replySlotTime)}`);
  logger.info(`Separated reply scheduled at ${formatSlotTime(replySlotTime)}, post ${replyPostId}`);
}

async function confirmNew(c: Confirm): Promise<void> {
  const { ctx, session, sessionKey } = c;

  const originalMessage = session.originalMessage;
  if (!originalMessage) {
    await ctx.reply('Session is corrupted. Please forward the message again.');
    return;
  }

  const selectedChannel = session.selectedChannel;
  if (!selectedChannel) {
    await ctx.reply('No channel selected.');
    return;
  }

  const mediaGroupMessages = session.mediaGroupMessages;
  const forwardInfo = parseForwardInfo(originalMessage);
  if (mediaGroupMessages && mediaGroupMessages.length > 1) {
    forwardInfo.mediaGroupMessageIds = mediaGroupMessages.map((msg) => msg.message_id);
  }
  // For reply chains, store all message IDs so the post worker forwards the full thread
  const replyChainMessages = session.replyChainMessages;
  if (replyChainMessages && replyChainMessages.length > 1) {
    forwardInfo.replyChainMessageIds = replyChainMessages.map((msg) => msg.message_id);
  }

  const content = extractMessageContent(originalMessage, mediaGroupMessages);
  if (!content) {
    await ctx.reply('Unsupported message type.');
    return;
  }

  const { textHandling = 'keep', selectedUserId, customText } = session;
  const baseParams = { targetChannelId: selectedChannel, originalMessage, forwardInfo, content };

  const { scheduledTime, postId } =
    session.selectedAction === 'forward'
      ? await postScheduler.scheduleForwardPost(baseParams)
      : await postScheduler.scheduleTransformPost({ ...baseParams, textHandling, selectedUserId, customText });

  await finalizePreview(c);

  await ctx.reply(
    `Post scheduled!\nTarget: ${await channelLabelById(selectedChannel)}\nScheduled for: ${formatSlotTime(scheduledTime)}`,
    { reply_markup: createAddReplyKeyboard(postId) }
  );

  logger.info(`Post scheduled from preview for session ${sessionKey}`);
}

// Route → confirm handler. Typed as Record<ScheduleRoute, …> so adding a route
// to the union without a handler here is a compile error.
const SCHEDULE_CONFIRM: Record<ScheduleRoute, (c: Confirm, route: ScheduleRoute) => Promise<void>> = {
  'edit-same-channel': confirmEdit,
  'edit-move-channel': confirmEdit,
  'reply-together': confirmReply,
  'reply-separated': confirmReply,
  normal: (c) => confirmNew(c),
};

export function registerScheduling(): void {

  // Handle channel selection
  bot.callbackQuery(/^select_channel:(.+)$/, transitionCallback(
    'Error processing channel selection. Please try again.',
    'Error in channel selection callback',
    async ({ ctx, session, originalMessage, match }) => {
      const selectedChannelId = match?.[1];
      if (!selectedChannelId) {
        await ctx.editMessageText('❌ Invalid channel selection.');
        return null;
      }

      // Reply sessions: advance to REPLY_SLOT_CHOICE and show slot keyboard
      if (session.isReply) {
        await getSessionService().updateState(session._id.toString(), SessionState.REPLY_SLOT_CHOICE, {
          selectedChannel: selectedChannelId,
        });
        await ctx.editMessageText('When should this reply be sent?', {
          reply_markup: createReplySlotKeyboard(session._id.toString()),
        });
        return null;
      }

      const shouldAutoForward = await transformerService.shouldAutoForward(parseForwardInfo(originalMessage));
      const isPoll = extractMessageContent(originalMessage)?.type === 'poll';

      return { type: 'CHANNEL_SELECTED', channelId: selectedChannelId, isGreenListed: shouldAutoForward, isPoll };
    }
  ));

  // Handle custom text selection
  bot.callbackQuery(/^custom_text:(add|skip)$/, transitionCallback(
    'Error processing custom text. Please try again.',
    'Error in custom text callback',
    async ({ ctx, session, match }) => {
      const action = match?.[1];
      if (!action) {
        await ErrorMessages.invalidSelection(ctx, 'action');
        return null;
      }

      if (action === 'add') {
        // Self-loop: stays in CUSTOM_TEXT, waiting for the user's reply with the text
        await getSessionService().updateState(session._id.toString(), SessionState.CUSTOM_TEXT, { waitingForCustomText: true });
        await ctx.editMessageText(
          '✍️ Reply to this message with your custom text.\n\n' +
            'This text will be added at the beginning of your post.'
        );
        return null;
      }

      return { type: 'CUSTOM_TEXT_SELECTED', text: undefined };
    }
  ));

  // Handle preset custom text selection
  bot.callbackQuery(/^custom_text:preset:(.+)$/, transitionCallback(
    'Error selecting preset text. Please try again.',
    'Error in custom text preset callback',
    async ({ ctx, match }) => {
      const presetId = match?.[1];
      if (!presetId) {
        await ErrorMessages.invalidSelection(ctx, 'preset');
        return null;
      }

      const preset = await CustomTextPreset.findById(presetId).lean();
      if (!preset) {
        await ctx.editMessageText('❌ Preset not found. It may have been deleted.');
        return null;
      }

      return { type: 'CUSTOM_TEXT_SELECTED', text: preset.text };
    }
  ));

  // Handle nickname selection
  bot.callbackQuery(/^select_nickname:(.+)$/, transitionCallback(
    'Error processing nickname selection. Please try again.',
    'Error in nickname selection callback',
    async ({ ctx, session, originalMessage, match }) => {
      const nicknameSelection = match?.[1];
      if (!nicknameSelection) {
        await ErrorMessages.invalidSelection(ctx, 'nickname');
        return null;
      }

      const userId = nicknameSelection === NICKNAME_NONE_KEY ? null : parseInt(nicknameSelection, 10);
      const isPlainText = computeIsPlainText(session.originalMessage ?? originalMessage);

      return { type: 'NICKNAME_SELECTED', userId, isPlainText };
    }
  ));

  // Handle text handling selection
  bot.callbackQuery(/^text:(keep|remove|quote)$/, transitionCallback(
    'Error processing text handling. Please try again.',
    'Error in text handling callback',
    async ({ ctx, session, originalMessage, match }) => {
      const handling = match?.[1] as 'keep' | 'remove' | 'quote' | undefined;
      if (!handling) {
        await ErrorMessages.invalidSelection(ctx, 'text handling option');
        return null;
      }

      const fullMessage = session.originalMessage ?? originalMessage;
      const isPlainText = computeIsPlainText(fullMessage);
      const knownNicknameUserId = await resolveKnownNicknameUserId(parseForwardInfo(fullMessage));

      return { type: 'TEXT_HANDLING_SELECTED', handling, isPlainText, knownNicknameUserId };
    }
  ));

  bot.callbackQuery('action:quick', transitionCallback(
    'Error processing quick post. Please try again.',
    'Error in quick post callback',
    ({ session, originalMessage }) => {
      const forwardInfo = parseForwardInfo(originalMessage);
      const content = extractMessageContent(originalMessage, session.mediaGroupMessages);
      const isTextOnly = content?.type === 'text' && (session.replyChainMessages?.length ?? 0) <= 1;

      return {
        type: 'ACTION_SELECTED',
        action: 'quick',
        hasText: false,
        hasBlockquotes: false,
        isPlainText: false,
        isTextOnly,
        fromUserId: forwardInfo.fromUserId,
      };
    }
  ));

  bot.callbackQuery('action:transform', transitionCallback(
    'Error processing transform. Please try again.',
    'Error in transform callback',
    async ({ session, originalMessage }) => {
      const content = extractMessageContent(originalMessage);
      const hasText = !!(content?.text?.trim());
      const hasBlockquotes = hasText && (content?.text?.includes('<blockquote>') ?? false);
      const fullMessage = session.originalMessage ?? originalMessage;
      const forwardInfo = parseForwardInfo(fullMessage);

      return {
        type: 'ACTION_SELECTED',
        action: 'transform',
        hasText,
        hasBlockquotes,
        isPlainText: computeIsPlainText(fullMessage),
        fromUserId: forwardInfo.fromUserId,
        knownNicknameUserId: await resolveKnownNicknameUserId(forwardInfo),
      };
    }
  ));

  bot.callbackQuery('action:forward', transitionCallback(
    'Error scheduling post. Please try again.',
    'Error in forward callback',
    async ({ ctx, session }) => {
      if (!session.selectedChannel) {
        await ErrorMessages.channelSelectionRequired(ctx);
        return null;
      }

      // The forward edge fires unconditionally on action='forward'; these fields are unused by its guard
      return { type: 'ACTION_SELECTED', action: 'forward', hasText: false, hasBlockquotes: false, isPlainText: false };
    }
  ));

  // Handle preview schedule button
  bot.callbackQuery(/^preview:schedule:(.+)$/, previewCallback(
    'Failed to schedule post. Please try again.',
    'Error in preview:schedule callback',
    async (c) => {
      const route = classifyScheduleConfirm(c.session);
      await SCHEDULE_CONFIRM[route](c, route);
    }
  ));

  // Handle preview cancel button
  bot.callbackQuery(/^preview:cancel:(.+)$/, previewCallback(
    'Error cancelling preview.',
    'Error in preview:cancel callback',
    async (c) => {
      const { ctx, session, sessionKey, sessionSvc } = c;
      await teardownPreviewMessages(c);

      // Edit sessions: original post stays untouched
      if (session.editingPostId) {
        await sessionSvc.complete(sessionKey);
        await ctx.reply('Edit cancelled.');
        logger.info(`Edit cancelled for session ${sessionKey}`);
        return;
      }

      await sessionSvc.complete(sessionKey);

      await ctx.reply('Cancelled. Forward a new message to start over.');

      logger.info(`Preview cancelled for session ${sessionKey}`);
    }
  ));

  // Handle preview back button — returns to channel selection
  bot.callbackQuery(/^preview:back:(.+)$/, previewCallback(
    'Error going back.',
    'Error in preview:back callback',
    async (c) => {
      const { ctx, session, sessionKey, sessionSvc, fromId } = c;
      await teardownPreviewMessages(c);

      // Edit sessions: re-send channel selection
      if (session.editingPostId) {
        await sessionSvc.updateState(sessionKey, SessionState.CHANNEL_SELECT, {
          selectedChannel: session.editingOriginalChannelId,
          selectedAction: undefined,
          textHandling: undefined,
          selectedUserId: undefined,
          customText: undefined,
          previewMessageId: undefined,
          previewMessageIds: undefined,
        });

        const channels = await getActivePostingChannels();
        if (channels.length === 0) {
          await ctx.reply('⚠️ No posting channels configured.');
          return;
        }
        if (!fromId) return;
        const keyboard = createEditChannelSelectKeyboard(channels, sessionKey);
        await ctx.api.sendMessage(fromId, '📍 Select target channel:', {
          reply_markup: keyboard,
        });

        logger.info(`Edit back: re-showing channel select for session ${sessionKey}`);
        return;
      }

      // Reset session back to channel selection state
      await sessionSvc.updateState(sessionKey, SessionState.CHANNEL_SELECT, {
        selectedChannel: undefined,
        selectedAction: undefined,
        selectedUserId: undefined,
        textHandling: undefined,
        customText: undefined,
        previewMessageId: undefined,
        previewMessageIds: undefined,
      });

      // Re-send channel selection keyboard
      const postingChannels = await getActivePostingChannels();
      if (postingChannels.length === 0) {
        await ctx.reply('⚠️ No posting channels configured.');
        return;
      }

      const channels = postingChannels.map(toChannelInfo);

      const origMsg = session.originalMessage;
      if (!origMsg) return;

      await ctx.api.sendMessage(
        origMsg.chat.id,
        '📍 Select target channel:',
        {
          reply_markup: createChannelSelectKeyboard(channels),
          reply_to_message_id: origMsg.message_id,
        }
      );

      logger.info(`Preview back for session ${sessionKey}`);
    }
  ));

  // Handle reply slot choice: together (same cycle as parent) or separated (own slot)
  bot.callbackQuery(/^reply_slot:(together|separated):(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const match = ctx.callbackQuery?.data?.match(/^reply_slot:(together|separated):(.+)$/);
      const mode = match?.[1] as 'together' | 'separated';
      const sessionId = match?.[2];

      if (!mode || !sessionId) {
        await ctx.editMessageText('❌ Invalid reply slot selection.');
        return;
      }

      const sessionSvc = getSessionService();
      const session = await sessionSvc.findById(sessionId);
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      await sessionSvc.updateState(sessionId, SessionState.ACTION_SELECT, { replyMode: mode });

      // Check for green-listed source — auto-forward if applicable
      const originalMessage = session.originalMessage;
      if (originalMessage) {
        const forwardInfo = parseForwardInfo(originalMessage);
        const shouldAutoForward = await transformerService.shouldAutoForward(forwardInfo);

        if (shouldAutoForward) {
          await sessionSvc.update(sessionId, { selectedAction: 'forward' });
          await showPreview(ctx, sessionId);
          return;
        }

        const content = extractMessageContent(originalMessage);
        if (content?.type === 'poll') {
          await sessionSvc.update(sessionId, { selectedAction: 'forward' });
          await showPreview(ctx, sessionId);
          return;
        }
      }

      const keyboard = createForwardActionKeyboard();
      await ctx.editMessageText(
        'Choose how to post this reply:\n⚡ <b>Quick post</b> — transform, no attribution, no extra text',
        { reply_markup: keyboard, parse_mode: 'HTML' }
      );

      logger.debug(`Reply slot mode "${mode}" set for session ${sessionId}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Error processing reply slot selection. Please try again.',
        'Error in reply_slot callback'
      );
    }
  });

}
