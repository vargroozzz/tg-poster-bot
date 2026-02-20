import { Api } from 'grammy';
import type { MessageContent } from '../../types/message.types.js';
import { MediaSenderService } from '../sending/media-sender.service.js';
import { createPreviewActionKeyboard } from '../../bot/keyboards/preview-action.keyboard.js';
import { logger } from '../../utils/logger.js';
import { DIContainer } from '../../shared/di/container.js';
import type { SessionService } from '../session/session.service.js';

export class PreviewSenderService {
  private mediaSender: MediaSenderService;

  constructor(private api: Api) {
    this.mediaSender = new MediaSenderService(api);
  }

  private getSessionService(): SessionService | undefined {
    if (DIContainer.has('SessionService')) {
      return DIContainer.resolve<SessionService>('SessionService');
    }
    return undefined;
  }

  async sendPreview(userId: number, content: MessageContent, sessionId: string): Promise<number> {
    // Look up the session to determine the action
    const sessionSvc = this.getSessionService();
    const session = sessionSvc ? await sessionSvc.findById(sessionId) : null;

    const previewMessageIds: number[] = [];

    if (session?.selectedAction === 'forward') {
      // For forward action: use forwardMessage(s) to preserve "Forwarded from" attribution
      const sourceChatId = session.originalMessage.chat.id;
      const replyChain = session.replyChainMessages;
      const mediaGroup = session.mediaGroupMessages;

      let forwarded = false;

      // Priority 1: reply chain (length > 1 means multiple messages to forward)
      if (replyChain && replyChain.length > 1) {
        const messageIds = replyChain.map((msg) => msg.message_id);
        try {
          const result = (await this.api.raw.forwardMessages({
            chat_id: userId,
            from_chat_id: sourceChatId,
            message_ids: messageIds,
          })) as Array<{ message_id: number }>;
          previewMessageIds.push(...result.map((r) => r.message_id));
          forwarded = true;
          logger.debug(
            `Forwarded reply chain of ${messageIds.length} messages to user ${userId} for preview`
          );
        } catch (error) {
          logger.error('Failed to forward reply chain for preview, falling back to placeholder:', error);
        }
      }
      // Priority 2: media group (length > 1)
      else if (mediaGroup && mediaGroup.length > 1) {
        const messageIds = mediaGroup.map((msg) => msg.message_id);
        try {
          const result = (await this.api.raw.forwardMessages({
            chat_id: userId,
            from_chat_id: sourceChatId,
            message_ids: messageIds,
          })) as Array<{ message_id: number }>;
          previewMessageIds.push(...result.map((r) => r.message_id));
          forwarded = true;
          logger.debug(
            `Forwarded media group of ${messageIds.length} messages to user ${userId} for preview`
          );
        } catch (error) {
          logger.error('Failed to forward media group for preview, falling back to placeholder:', error);
        }
      }
      // Priority 3: single message
      else {
        try {
          const result = await this.api.forwardMessage(
            userId,
            sourceChatId,
            session.originalMessage.message_id
          );
          previewMessageIds.push(result.message_id);
          forwarded = true;
          logger.debug(
            `Forwarded single message ${session.originalMessage.message_id} to user ${userId} for preview`
          );
        } catch (error) {
          logger.error('Failed to forward single message for preview, falling back to placeholder:', error);
        }
      }

      // Fallback: send a text placeholder if forwarding failed
      if (!forwarded) {
        const count =
          replyChain && replyChain.length > 1
            ? replyChain.length
            : (mediaGroup && mediaGroup.length > 1 ? mediaGroup.length : 1);
        const fallbackContent: MessageContent = {
          type: 'text',
          text: `🧵 Thread of ${count} message${count > 1 ? 's' : ''} will be forwarded (preview unavailable)`,
        };
        const fallbackId = await this.mediaSender.sendMessage(userId, fallbackContent);
        previewMessageIds.push(fallbackId);
      }
    } else {
      // For transform action (or unknown): use MediaSenderService as before
      const contentMsgId = await this.mediaSender.sendMessage(userId, content);
      previewMessageIds.push(contentMsgId);
    }

    // Update session with previewMessageIds for multi-message cleanup
    if (sessionSvc && previewMessageIds.length > 0) {
      await sessionSvc.update(sessionId, {
        previewMessageIds,
      });
      logger.debug(`Stored ${previewMessageIds.length} preview message ID(s) on session ${sessionId}`);
    }

    // Send a separate control message with the action keyboard.
    // editMessageReplyMarkup cannot be used on media group messages, and is
    // unreliable for other media types in some clients, so a dedicated text
    // message with the keyboard is the most reliable approach.
    const keyboard = createPreviewActionKeyboard(sessionId);
    const controlMessage = await this.api.sendMessage(userId, 'What would you like to do?', {
      reply_markup: keyboard,
    });

    logger.debug(`Preview sent to user ${userId}, control message ID: ${controlMessage.message_id}`);
    return controlMessage.message_id;
  }
}
