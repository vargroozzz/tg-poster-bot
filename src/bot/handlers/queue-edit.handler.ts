import { Context } from 'grammy';
import { bot } from '../bot.js';
import { DIContainer } from '../../shared/di/container.js';
import type { SessionService } from '../../core/session/session.service.js';
import { SessionState } from '../../shared/constants/flow-states.js';
import { ScheduledPostRepository } from '../../database/repositories/scheduled-post.repository.js';
import { getActivePostingChannels } from '../../database/models/posting-channel.model.js';
import { transformerService } from '../../services/transformer.service.js';
import { PreviewGeneratorService } from '../../core/preview/preview-generator.service.js';
import { PreviewSenderService } from '../../core/preview/preview-sender.service.js';
import { CustomTextPreset } from '../../database/models/custom-text-preset.model.js';
import { findNicknameByUserId, getNicknameOptions } from '../../shared/helpers/nickname.helper.js';
import { ErrorMessages } from '../../shared/constants/error-messages.js';
import { logger } from '../../utils/logger.js';
import { queuePreviewStateMap } from './callback.handler.js';
import {
  createEditChannelSelectKeyboard,
  createEditForwardActionKeyboard,
  createEditTextHandlingKeyboard,
  createEditNicknameKeyboard,
  createEditCustomTextKeyboard,
} from '../keyboards/edit-keyboards.js';

let sessionService: SessionService;
function getSessionService(): SessionService | undefined {
  if (!sessionService && DIContainer.has('SessionService')) {
    sessionService = DIContainer.resolve<SessionService>('SessionService');
  }
  return sessionService;
}

// ── Entry point ──────────────────────────────────────────────────────────────

bot.callbackQuery(/^queue:edit:([a-f0-9]{24})$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const postId = (ctx.match as RegExpExecArray)[1];
    const userId = ctx.from?.id;
    if (!userId) return;

    const repository = new ScheduledPostRepository();
    const post = await repository.findById(postId);
    if (!post) {
      await ctx.answerCallbackQuery({ text: '❌ Post already published or deleted', show_alert: true });
      return;
    }

    const state = queuePreviewStateMap.get(userId);
    if (state) {
      for (const msgId of state.previewMessageIds) {
        await ctx.api.deleteMessage(userId, msgId).catch(() => {});
      }
      queuePreviewStateMap.delete(userId);
    }
    await ctx.deleteMessage().catch(() => {});

    const sessionSvc = getSessionService();
    if (!sessionSvc) {
      await ctx.reply('❌ Service unavailable. Please try again.');
      return;
    }

    const session = await sessionSvc.createForEdit(userId, post);
    const sessionId = session._id.toString();

    const channels = await getActivePostingChannels();
    if (channels.length === 0) {
      await ctx.reply('⚠️ No posting channels configured.');
      return;
    }

    const keyboard = createEditChannelSelectKeyboard(channels, sessionId);
    await ctx.api.sendMessage(userId, '📍 Select target channel:', {
      reply_markup: keyboard as any,
    });

    logger.debug(`Edit session ${sessionId} started for user ${userId}, post ${postId}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error starting edit.', 'queue:edit entry');
  }
});

// ── Channel selection ─────────────────────────────────────────────────────────

bot.callbackQuery(/^queue:edit:ch:([^:]+):(-?\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const [, sessionId, channelId] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    const isGreenListed = session.editingOriginalForward
      ? await transformerService.shouldAutoForward(session.editingOriginalForward)
      : false;
    const isRedListed = session.editingOriginalForward?.fromChannelId
      ? await transformerService.isRedListed(String(session.editingOriginalForward.fromChannelId))
      : false;
    const rawContent = session.editingRawContent!;
    const hasText = !!(rawContent.text && rawContent.text.trim().length > 0);
    const isPoll = rawContent.type === 'poll';

    await sessionSvc!.updateState(sessionId, SessionState.CHANNEL_SELECT, {
      selectedChannel: channelId,
    });

    if (isPoll) {
      await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, { selectedAction: 'forward' });
      await showEditPreview(ctx, sessionId);
      return;
    }

    if (isGreenListed) {
      await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, { selectedAction: 'forward' });
      await showEditPreview(ctx, sessionId);
      return;
    }

    if (isRedListed) {
      await sessionSvc!.update(sessionId, { selectedAction: 'transform' });
      if (hasText) {
        await ctx.editMessageText('How should the text be handled?', {
          reply_markup: createEditTextHandlingKeyboard(sessionId) as any,
        });
      } else {
        await showEditNicknameStep(ctx, sessionId);
      }
      return;
    }

    await ctx.editMessageText(
      'Choose how to post this message:\n⚡ <b>Quick post</b> — transform, no attribution, no extra text',
      { reply_markup: createEditForwardActionKeyboard(sessionId) as any, parse_mode: 'HTML' }
    );
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting channel.', 'queue:edit:ch');
  }
});

// ── Action selection ──────────────────────────────────────────────────────────

bot.callbackQuery(/^queue:edit:action:([^:]+):(transform|forward|quick)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const [, sessionId, action] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    const rawContent = session.editingRawContent!;
    const hasText = !!(rawContent.text && rawContent.text.trim().length > 0);

    if (action === 'quick') {
      const autoNickname = session.editingOriginalForward?.fromUserId
        ? await findNicknameByUserId(session.editingOriginalForward.fromUserId) ?? null
        : null;
      await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, {
        selectedAction: 'transform',
        textHandling: 'remove',
        selectedNickname: autoNickname,
        customText: undefined,
      });
      await showEditPreview(ctx, sessionId);
      return;
    }

    if (action === 'forward') {
      await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, { selectedAction: 'forward' });
      await showEditPreview(ctx, sessionId);
      return;
    }

    await sessionSvc!.update(sessionId, { selectedAction: 'transform' });
    if (hasText) {
      await ctx.editMessageText('How should the text be handled?', {
        reply_markup: createEditTextHandlingKeyboard(sessionId) as any,
      });
    } else {
      await showEditNicknameStep(ctx, sessionId);
    }
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting action.', 'queue:edit:action');
  }
});

// ── Text handling ─────────────────────────────────────────────────────────────

bot.callbackQuery(/^queue:edit:text:([^:]+):(keep|remove|quote)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const [, sessionId, textHandling] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    await sessionSvc!.update(sessionId, {
      textHandling: textHandling as 'keep' | 'remove' | 'quote',
    });
    await showEditNicknameStep(ctx, sessionId);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting text handling.', 'queue:edit:text');
  }
});

// ── Nickname selection ────────────────────────────────────────────────────────

bot.callbackQuery(/^queue:edit:nickname:([^:]+):([^:]+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const [, sessionId, nicknameKey] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    let selectedNickname: string | null = null;
    if (nicknameKey !== 'none') {
      const uid = parseInt(nicknameKey, 10);
      if (!isNaN(uid)) {
        selectedNickname = await findNicknameByUserId(uid);
      }
    }

    await sessionSvc!.update(sessionId, { selectedNickname });

    const keyboard = await createEditCustomTextKeyboard(sessionId);
    await ctx.editMessageText('Do you want to add custom text to this post?', {
      reply_markup: keyboard as any,
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting nickname.', 'queue:edit:nickname');
  }
});

// ── Custom text ───────────────────────────────────────────────────────────────

bot.callbackQuery(/^queue:edit:custom:([^:]+):(add|skip)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const [, sessionId, choice] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    if (choice === 'skip') {
      await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, { customText: undefined });
      await showEditPreview(ctx, sessionId);
    } else {
      await sessionSvc!.updateState(sessionId, SessionState.CUSTOM_TEXT, {
        waitingForCustomText: true,
      });
      await ctx.editMessageText(
        '✍️ Reply to this message with your custom text.\n\nThis text will be added at the beginning of your post.'
      );
    }
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error with custom text.', 'queue:edit:custom');
  }
});

// ec:preset:{sessionId}:{presetId} — shortened to stay under Telegram's 64-byte callback_data limit
bot.callbackQuery(/^ec:preset:([^:]+):(.+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const [, sessionId, presetId] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    const preset = await CustomTextPreset.findById(presetId).lean();
    if (!preset) {
      await ctx.editMessageText('❌ Preset not found. It may have been deleted.');
      return;
    }

    await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, { customText: preset.text });
    await showEditPreview(ctx, sessionId);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting preset.', 'ec:preset');
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function showEditPreview(ctx: Context, sessionId: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const sessionSvc = getSessionService();
  const session = await sessionSvc?.findById(sessionId);
  if (!session) {
    await ctx.reply('❌ Edit session expired. Use /queue to start again.');
    return;
  }

  try {
    const previewGenerator = new PreviewGeneratorService();
    const previewContent = await previewGenerator.generatePreview(session);

    const previewSender = new PreviewSenderService(ctx.api);
    await previewSender.sendPreview(userId, previewContent, sessionId);

    await ctx.deleteMessage().catch(() => {});
    await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, {});
    logger.debug(`Edit preview shown for session ${sessionId}`);
  } catch (error) {
    logger.error('Error showing edit preview:', error);
    await ctx.editMessageText('❌ Preview generation failed. Please try again.');
  }
}

async function showEditNicknameStep(ctx: Context, sessionId: string): Promise<void> {
  const sessionSvc = getSessionService();
  const session = await sessionSvc?.findById(sessionId);
  if (!session) return;

  const fromUserId = session.editingOriginalForward?.fromUserId;
  if (fromUserId) {
    const autoNickname = await findNicknameByUserId(fromUserId);
    if (autoNickname) {
      await sessionSvc!.update(sessionId, { selectedNickname: autoNickname });
      const keyboard = await createEditCustomTextKeyboard(sessionId);
      await ctx.editMessageText('Do you want to add custom text to this post?', {
        reply_markup: keyboard as any,
      });
      return;
    }
  }

  const options = await getNicknameOptions();
  const keyboard = createEditNicknameKeyboard(options, sessionId);
  await ctx.editMessageText('Who should be credited for this post?', {
    reply_markup: keyboard as any,
  });
}
