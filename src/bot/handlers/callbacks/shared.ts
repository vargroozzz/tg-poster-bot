// src/bot/handlers/callbacks/shared.ts
import { Context } from 'grammy';
import type { InlineKeyboardMarkup, Message } from 'grammy/types';
import { config } from '../../../config/index.js';
import { resolveProposerCredit } from '../../../core/proposals/proposal.js';
import { parseForwardInfo } from '../../../utils/message-parser.js';
import type { ISession } from '../../../database/models/session.model.js';
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
import { createForwardActionKeyboard } from '../../keyboards/forward-action.keyboard.js';
import { createTextChoiceKeyboard } from '../../keyboards/text-handling.keyboard.js';
import { entitiesToHtml } from '../../../utils/entities-to-html.js';

export async function resolveKnownNicknameUserId(forwardInfo: ForwardInfo): Promise<number | undefined> {
  const { fromUserId } = forwardInfo;
  if (!fromUserId) return undefined;
  const nickname = await findNicknameByUserId(fromUserId);
  return nickname ? fromUserId : undefined;
}

// Who to credit for this post. A handed-off proposal always credits the original proposer
// (session.proposedByUserId) — even while the owner adjusts it via Back — otherwise fall
// back to the normal owner-vs-proposer rule.
export function creditUserId(session: ISession, ctx: Context, sourceKnownId: number | undefined): number | undefined {
  if (session.proposedByUserId != null) return session.proposedByUserId;
  const isOwner = ctx.from?.id === config.authorizedUserId;
  return resolveProposerCredit(isOwner, ctx.from?.id ?? 0, sourceKnownId);
}

// Credit that can be resolved without asking: a known nickname for the source (or the
// proposer). Undefined means the nickname step still has to run.
export async function knownCredit(ctx: Context, session: ISession, originalMessage: Message): Promise<number | undefined> {
  const fullMessage = session.originalMessage ?? originalMessage;
  return creditUserId(session, ctx, await resolveKnownNicknameUserId(parseForwardInfo(fullMessage)));
}

export const TEXT_CHOICE_PROMPT = 'What text should the post have?';
export const NICKNAME_PROMPT = 'Who should be credited for this post?';

// The original text of the post, as HTML — the caption may live on any message of an album.
function originalTextHtml(session?: ISession): string {
  const messages = session?.mediaGroupMessages?.length
    ? session.mediaGroupMessages
    : session?.originalMessage
      ? [session.originalMessage]
      : [];
  const source = messages.find((m) => m.text ?? m.caption);
  if (!source) return '';

  return entitiesToHtml(source.text ?? source.caption ?? '', source.entities ?? source.caption_entities).trim();
}

export async function textChoiceKeyboardFor(sessionId: string): Promise<InlineKeyboardMarkup> {
  const html = originalTextHtml(await getSessionService().findById(sessionId) ?? undefined);
  // '<blockquote' (not '<blockquote>') so expandable quotes count too.
  return createTextChoiceKeyboard(!!html, html.includes('<blockquote'));
}

type StepRenderer = (ctx: Context, sessionId: string) => Promise<void>;

const STEP_RENDERERS: Record<FlowStep['type'], StepRenderer> = {
  show_action_select: async ctx => {
    await ctx.editMessageText(
      'Choose how to post this message:\n⚡ <b>Quick post</b> — transform, no attribution, no extra text',
      { reply_markup: createForwardActionKeyboard(), parse_mode: 'HTML' }
    );
  },
  show_text_handling: async (ctx, sessionId) => {
    await ctx.editMessageText(TEXT_CHOICE_PROMPT, {
      reply_markup: await textChoiceKeyboardFor(sessionId),
    });
  },
  show_nickname_select: async ctx => {
    await ctx.editMessageText(NICKNAME_PROMPT, { reply_markup: await getNicknameKeyboard() });
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

