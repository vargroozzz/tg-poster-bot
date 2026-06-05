// src/bot/handlers/callbacks/shared.ts
import { Context } from 'grammy';
import { Message } from 'grammy/types';
import { DIContainer } from '../../../shared/di/container.js';
import type { SessionService } from '../../../core/session/session.service.js';
import { SessionState } from '../../../shared/constants/flow-states.js';
import type { FlowStep } from '../../../shared/constants/flow-states.js';
import type { ForwardInfo } from '../../../types/message.types.js';
import { logger } from '../../../utils/logger.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { PreviewGeneratorService } from '../../../core/preview/preview-generator.service.js';
import { PreviewSenderService } from '../../../core/preview/preview-sender.service.js';
import {
  findNicknameByUserId,
  getNicknameKeyboard,
} from '../../../shared/helpers/nickname.helper.js';
import { createCustomTextKeyboard } from '../../keyboards/custom-text.keyboard.js';
import { createForwardActionKeyboard } from '../../keyboards/forward-action.keyboard.js';
import { createTextHandlingKeyboard } from '../../keyboards/text-handling.keyboard.js';

export function computeIsPlainText(message: Message): boolean {
  return (
    message.text !== undefined &&
    !('photo' in message && message.photo) &&
    !('video' in message && message.video) &&
    !('document' in message && message.document) &&
    !('animation' in message && message.animation) &&
    !('external_reply' in message && (message as unknown as Record<string, unknown>).external_reply) &&
    !message.forward_origin
  );
}

export async function resolveKnownNicknameUserId(forwardInfo: ForwardInfo): Promise<number | undefined> {
  const { fromUserId } = forwardInfo;
  if (!fromUserId) return undefined;
  const nickname = await findNicknameByUserId(fromUserId);
  return nickname ? fromUserId : undefined;
}

type StepRenderer = (ctx: Context, sessionId: string) => Promise<void>;

const STEP_RENDERERS: Record<FlowStep['type'], StepRenderer> = {
  show_action_select: async ctx => {
    await ctx.editMessageText(
      'Choose how to post this message:\n⚡ <b>Quick post</b> — transform, no attribution, no extra text',
      { reply_markup: createForwardActionKeyboard(), parse_mode: 'HTML' }
    );
  },
  show_text_handling: async ctx => {
    await ctx.editMessageText('How should the text be handled?', { reply_markup: createTextHandlingKeyboard() });
  },
  show_nickname_select: async ctx => {
    await ctx.editMessageText('Who should be credited for this post?', { reply_markup: await getNicknameKeyboard() });
  },
  show_custom_text: async ctx => {
    await ctx.editMessageText('Do you want to add custom text to this post?', {
      reply_markup: await createCustomTextKeyboard(),
    });
  },
  show_preview: (ctx, sessionId) => showPreview(ctx, sessionId),
};

export const renderStep = (ctx: Context, step: FlowStep, sessionId: string): Promise<void> =>
  STEP_RENDERERS[step.type](ctx, sessionId);

let _sessionService: SessionService;

export function getSessionService(): SessionService {
  if (!_sessionService) {
    _sessionService = DIContainer.resolve('SessionService');
  }
  return _sessionService;
}

export async function deletePreviewMessages(
  ctx: Context,
  fromId: number,
  session: { previewMessageIds?: number[]; previewMessageId?: number }
): Promise<void> {
  const messageIds =
    (session.previewMessageIds?.length ?? 0) > 0
      ? (session.previewMessageIds ?? [])
      : session.previewMessageId
        ? [session.previewMessageId]
        : [];

  await Promise.all(
    messageIds.map((msgId) =>
      ctx.api
        .deleteMessage(fromId, msgId)
        .catch((err) => logger.warn(`Failed to delete preview message ${msgId}:`, err))
    )
  );
}

export async function showPreview(ctx: Context, sessionKey: string): Promise<void> {
  try {
    const fromId = ctx.from?.id;
    if (!fromId) return;

    const sessionSvc = getSessionService();
    const session = await sessionSvc.findById(sessionKey);
    if (!session) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    const previewContent = await new PreviewGeneratorService().generatePreview(session);
    const previewMessageId = await new PreviewSenderService(ctx.api).sendPreview(
      fromId,
      previewContent,
      sessionKey
    );

    await sessionSvc.updateState(sessionKey, SessionState.PREVIEW, { previewMessageId });
    await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));

    logger.debug(`Preview shown for session ${sessionKey}`);
  } catch (error) {
    logger.error('Error showing preview:', error);
    await ctx.editMessageText('Preview generation failed. Please try again.');
  }
}

