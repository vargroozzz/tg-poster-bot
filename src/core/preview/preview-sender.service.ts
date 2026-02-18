import { Api } from 'grammy';
import type { MessageContent } from '../../types/message.types.js';
import { MediaSenderService } from '../sending/media-sender.service.js';
import { createPreviewActionKeyboard } from '../../bot/keyboards/preview-action.keyboard.js';
import { logger } from '../../utils/logger.js';

export class PreviewSenderService {
  private mediaSender: MediaSenderService;

  constructor(private api: Api) {
    this.mediaSender = new MediaSenderService(api);
  }

  async sendPreview(userId: number, content: MessageContent, sessionId: string): Promise<number> {
    // Send the content first
    await this.mediaSender.sendMessage(userId, content);

    // Send a separate message with the action keyboard.
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
