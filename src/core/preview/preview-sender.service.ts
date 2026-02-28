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

    if (!sessionSvc) {
      logger.warn('SessionService unavailable in PreviewSenderService, falling back to transform preview');
    }

    const session = sessionSvc ? await sessionSvc.findById(sessionId) : null;

    if (sessionSvc && !session) {
      throw new Error(`Session ${sessionId} not found when generating preview`);
    }

    const previewMessageIds: number[] = [];

    if (session?.selectedAction === 'forward') {
      // For forward action: use forwardMessage(s) to preserve "Forwarded from" attribution
      const sourceChatId = session.originalMessage.chat.id;
      const replyChain = session.replyChainMessages;
      const mediaGroup = session.mediaGroupMessages;

      // Pick the bulk message list (reply chain takes priority over media group)
      const bulkMessages =
        (replyChain?.length ?? 0) > 1 ? replyChain :
        (mediaGroup?.length ?? 0) > 1 ? mediaGroup :
        null;

      if (bulkMessages) {
        const messageIds = bulkMessages.map((msg) => msg.message_id);
        try {
          const result = (await this.api.raw.forwardMessages({
            chat_id: userId,
            from_chat_id: sourceChatId,
            message_ids: messageIds,
          })) as Array<{ message_id: number }>;
          previewMessageIds.push(...result.map((r) => r.message_id));
          logger.debug(`Forwarded ${messageIds.length} messages to user ${userId} for preview`);
        } catch (error) {
          logger.error('Failed to forward messages for preview, falling back to placeholder:', error);
        }
      } else {
        try {
          const result = await this.api.forwardMessage(
            userId,
            sourceChatId,
            session.originalMessage.message_id
          );
          previewMessageIds.push(result.message_id);
          logger.debug(`Forwarded single message ${session.originalMessage.message_id} to user ${userId} for preview`);
        } catch (error) {
          logger.error('Failed to forward single message for preview, falling back to placeholder:', error);
        }
      }

      // Fallback: send a text placeholder if forwarding failed
      if (previewMessageIds.length === 0) {
        const count = bulkMessages?.length ?? 1;
        const fallbackContent: MessageContent = {
          type: 'text',
          text: `🧵 Thread of ${count} message${count > 1 ? 's' : ''} will be forwarded (preview unavailable)`,
        };
        const fallbackId = await this.mediaSender.sendMessage(userId, fallbackContent);
        previewMessageIds.push(fallbackId);
      }
    } else {
      // For transform action (or unknown): use MediaSenderService
      if (content.type === 'media_group' && content.mediaGroup && content.mediaGroup.length > 0) {
        // Collect all album message IDs so every item can be deleted on cleanup
        const ids = await this.mediaSender.sendMediaGroupAll(userId, content.mediaGroup, content.text);
        previewMessageIds.push(...ids);
      } else {
        const contentMsgId = await this.mediaSender.sendMessage(userId, content);
        previewMessageIds.push(contentMsgId);
      }
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
