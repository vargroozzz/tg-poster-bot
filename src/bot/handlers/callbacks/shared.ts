// src/bot/handlers/callbacks/shared.ts
import { Context } from 'grammy';
import { Message } from 'grammy/types';
import { DIContainer } from '../../../shared/di/container.js';
import type { SessionService } from '../../../core/session/session.service.js';
import { SessionState } from '../../../shared/constants/flow-states.js';
import { logger } from '../../../utils/logger.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { PreviewGeneratorService } from '../../../core/preview/preview-generator.service.js';
import { PreviewSenderService } from '../../../core/preview/preview-sender.service.js';
import { parseForwardInfo } from '../../../utils/message-parser.js';
import {
  findNicknameByUserId,
  getNicknameKeyboard,
} from '../../../shared/helpers/nickname.helper.js';
import { createCustomTextKeyboard } from '../../keyboards/custom-text.keyboard.js';

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

/**
 * Auto-selects a nickname if the message is from a known user; otherwise shows the
 * nickname selection keyboard. Returns true when auto-selected (caller need not show keyboard).
 */
export async function handleNicknameSelection(
  ctx: Context,
  originalMessage: Message,
  sessionId?: string,
  isPlainText?: boolean
): Promise<boolean> {
  const forwardInfo = parseForwardInfo(originalMessage);
  const fromUserId = forwardInfo?.fromUserId;

  if (fromUserId) {
    const nickname = await findNicknameByUserId(fromUserId);
    if (nickname) {
      logger.debug(`Auto-selecting nickname "${nickname}" for user ${fromUserId}`);
      if (sessionId) {
        await getSessionService().update(sessionId, { selectedUserId: fromUserId });
      }

      if (isPlainText && sessionId) {
        await showPreview(ctx, sessionId);
      } else {
        const keyboard = await createCustomTextKeyboard();
        await ctx.editMessageText('Do you want to add custom text to this post?', {
          reply_markup: keyboard,
        });
      }
      return true;
    }
  }

  const keyboard = await getNicknameKeyboard();
  await ctx.editMessageText('Who should be credited for this post?', {
    reply_markup: keyboard,
  });
  return false;
}
