import { Api } from 'grammy';
import type { InlineKeyboardMarkup, MessageOriginChannel } from 'grammy/types';
import type { MessageContent } from '../../types/message.types.js';
import { MediaSenderService, supportsTextAbove } from '../sending/media-sender.service.js';
import { createPreviewActionKeyboard } from '../../bot/keyboards/preview-action.keyboard.js';
import { logger } from '../../utils/logger.js';
import { DIContainer } from '../../shared/di/container.js';
import type { SessionService } from '../session/session.service.js';
import type { ISession } from '../../database/models/session.model.js';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { PostingChannel } from '../../database/models/posting-channel.model.js';
import { channelLabel } from '../../shared/helpers/channel.helper.js';
import { findNextAvailableSlot, formatSlotTime } from '../../utils/time-slots.js';
import { hasPlaceableText, textAboveFor, spoilersFor } from '../session/preview-route.js';
import { spoilerSlots, withSpoilers } from '../sending/spoilers.js';

/**
 * The preview's action keyboard for the session as it stands. Shared with the buttons that
 * adjust a live preview, so a keyboard they rebuild matches the one sendPreview would.
 * `content` must already carry the spoiler overrides.
 */
export function previewKeyboardFor(
  session: ISession,
  sessionId: string,
  content: MessageContent
): InlineKeyboardMarkup {
  // The toggle is only meaningful for a transformed post that has body text to place and
  // media that can carry a caption above (a forward reposts the original untouched).
  const textPlacement =
    hasPlaceableText(session) && session.selectedAction !== 'forward' && supportsTextAbove(content)
      ? textAboveFor(session)
        ? 'above'
        : 'below'
      : undefined;

  // Same rule for spoilers.
  const slots = session.selectedAction === 'forward' ? [] : spoilerSlots(content);

  return createPreviewActionKeyboard(sessionId, textPlacement, slots, session.spoilerMenu);
}

export class PreviewSenderService {
  private mediaSender: MediaSenderService;

  constructor(private api: Api) {
    this.mediaSender = new MediaSenderService(api);
  }

  private getSessionService(): SessionService {
    return DIContainer.resolve('SessionService');
  }

  async sendPreview(
    userId: number,
    rawContent: MessageContent,
    sessionId: string,
    options?: { keyboard?: InlineKeyboardMarkup; controlPrefix?: string }
  ): Promise<number> {
    const sessionSvc = this.getSessionService();
    const session = await sessionSvc.findById(sessionId);

    if (!session) {
      throw new Error(`Session ${sessionId} not found when generating preview`);
    }

    // Preview what will actually be posted, spoiler choices included.
    const content = withSpoilers(rawContent, spoilersFor(session));

    const previewMessageIds: number[] = [];
    // The message holding the caption (album head or the single media message), so a
    // text-placement toggle can edit it in place instead of re-sending the preview.
    let contentMessageId: number | undefined;

    if (session.selectedAction === 'forward') {
      let sourceChatId: number;
      let bulkMessageIds: number[] | null = null;
      let singleMessageId: number;

      if (session.editingPostId) {
        // Edit session: source info comes from stored forwardInfo
        const fwd = session.editingOriginalForward;
        if (!fwd) throw new Error(`Edit session ${sessionId} missing editingOriginalForward`);
        sourceChatId = fwd.chatId;
        singleMessageId = fwd.messageId;
        const bulkIds = fwd.replyChainMessageIds ?? fwd.mediaGroupMessageIds ?? null;
        bulkMessageIds = bulkIds && bulkIds.length > 1 ? bulkIds : null;
      } else {
        const origMsg = session.originalMessage;
        if (!origMsg) throw new Error(`Session ${sessionId} missing originalMessage`);
        sourceChatId = origMsg.chat.id;
        singleMessageId = origMsg.message_id;
        const replyChain = session.replyChainMessages;
        const mediaGroup = session.mediaGroupMessages;
        const bulkMessages =
          (replyChain?.length ?? 0) > 1 ? replyChain :
          (mediaGroup?.length ?? 0) > 1 ? mediaGroup :
          null;
        bulkMessageIds = bulkMessages ? bulkMessages.map((msg) => msg.message_id) : null;
      }

      if (bulkMessageIds) {
        try {
          const result = await this.api.forwardMessages(userId, sourceChatId, bulkMessageIds);
          previewMessageIds.push(...result.map((r) => r.message_id));
          logger.debug(`Forwarded ${bulkMessageIds.length} messages to user ${userId} for preview`);
        } catch (error) {
          logger.error('Failed to forward messages for preview, falling back to placeholder:', error);
        }
      } else {
        try {
          const result = await this.api.forwardMessage(userId, sourceChatId, singleMessageId);
          previewMessageIds.push(result.message_id);
          logger.debug(`Forwarded single message ${singleMessageId} to user ${userId} for preview`);
        } catch (error) {
          logger.error('Failed to forward single message for preview, falling back to placeholder:', error);
        }
      }

      // Fallback placeholder if forwarding failed
      if (previewMessageIds.length === 0) {
        const count = bulkMessageIds?.length ?? 1;
        const fallbackContent: MessageContent = {
          type: 'text',
          text: `🧵 Thread of ${count} message${count > 1 ? 's' : ''} will be forwarded (preview unavailable)`,
        };
        const fallbackId = await this.mediaSender.sendMessage(userId, fallbackContent);
        previewMessageIds.push(fallbackId);
      }
    } else {
      // For transform action (or unknown): use MediaSenderService
      const forwardInfo = session.editingPostId
        ? session.editingOriginalForward
        : session.originalMessage ? parseForwardInfo(session.originalMessage) : undefined;
      const replyParams = forwardInfo?.replyParameters ?? undefined;

      // For replies: forward the replied-to message into the PM as visual context,
      // since cross-chat reply_parameters are rejected in private chats by Telegram.
      if (replyParams) {
        // external_reply.chat may point to a private linked discussion group copy.
        // Prefer external_reply.origin (always the original public channel) for forwarding.
        const extOrigin = session.originalMessage?.external_reply?.origin;
        const channelOrigin =
          extOrigin?.type === 'channel' ? (extOrigin as MessageOriginChannel) : null;
        const fwdChatId = channelOrigin ? channelOrigin.chat.id : replyParams.chatId;
        const fwdMessageId = channelOrigin ? channelOrigin.message_id : replyParams.messageId;
        logger.debug(`Preview reply context: chatId=${fwdChatId}, messageId=${fwdMessageId}`);
        try {
          const contextMsg = await this.api.forwardMessage(userId, fwdChatId, fwdMessageId);
          previewMessageIds.push(contextMsg.message_id);
        } catch (err) {
          logger.warn('Could not forward replied-to message for preview context, using placeholder:', err);
          const channelTitle = channelOrigin?.chat.title;
          const placeholderContent: MessageContent = {
            type: 'text',
            text: `↩️ Reply to: ${channelTitle ?? 'channel post'}`,
          };
          const placeholderId = await this.mediaSender.sendMessage(userId, placeholderContent);
          previewMessageIds.push(placeholderId);
        }
      }

      if (content.type === 'media_group' && content.mediaGroup && content.mediaGroup.length > 0) {
        // Collect all album message IDs so every item can be deleted on cleanup
        const ids = await this.mediaSender.sendMediaGroupAll(
          userId,
          content.mediaGroup,
          content.text,
          undefined,
          textAboveFor(session)
        );
        previewMessageIds.push(...ids);
        contentMessageId = ids[0];
      } else {
        contentMessageId = await this.mediaSender.sendMessage(
          userId,
          content,
          undefined,
          textAboveFor(session)
        );
        previewMessageIds.push(contentMessageId);
      }
    }

    // Update session with previewMessageIds for multi-message cleanup
    if (sessionSvc && previewMessageIds.length > 0) {
      await sessionSvc.update(sessionId, {
        previewMessageIds,
        previewContentMessageId: contentMessageId,
      });
      logger.debug(`Stored ${previewMessageIds.length} preview message ID(s) on session ${sessionId}`);
    }

    // Send a separate control message with the action keyboard.
    // editMessageReplyMarkup cannot be used on media group messages, and is
    // unreliable for other media types in some clients, so a dedicated text
    // message with the keyboard is the most reliable approach.
    const keyboard = options?.keyboard ?? previewKeyboardFor(session, sessionId, content);
    const baseControl = await this.buildControlMessage(session.selectedChannel);
    const controlText = options?.controlPrefix
      ? `${options.controlPrefix}\n\n${baseControl}`
      : baseControl;
    const controlMessage = await this.api.sendMessage(userId, controlText, {
      reply_markup: keyboard,
      parse_mode: 'HTML',
    });

    logger.debug(`Preview sent to user ${userId}, control message ID: ${controlMessage.message_id}`);
    return controlMessage.message_id;
  }

  private async buildControlMessage(channelId?: string): Promise<string> {
    if (!channelId) {
      return ['', 'Schedule or cancel?'].join('\n');
    }

    const [channel, slot] = await Promise.all([
      PostingChannel.findOne({ channelId }).lean(),
      findNextAvailableSlot(channelId).catch(() => undefined), // skip slot line if lookup fails
    ]);

    return [
      `📢 <b>${channel ? channelLabel(channel) : channelId}</b>`,
      slot ? `🕐 ${formatSlotTime(slot)}` : undefined,
      '',
      'Schedule or cancel?',
    ]
      .filter((line) => line !== undefined)
      .join('\n');
  }
}
