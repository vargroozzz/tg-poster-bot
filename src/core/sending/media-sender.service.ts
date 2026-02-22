import { Api } from 'grammy';
import type { MessageContent, MediaGroupItem } from '../../types/message.types.js';

/**
 * Shared service for sending media to Telegram
 * Used by both preview and publishing to avoid code duplication
 */
export class MediaSenderService {
  constructor(private api: Api) {}

  /**
   * Send message based on content type
   * Returns the Telegram message ID
   */
  async sendMessage(chatId: number | string, content: MessageContent): Promise<number> {
    switch (content.type) {
      case 'photo':
        return await this.sendPhoto(chatId, content.fileId!, content.text);
      case 'video':
        return await this.sendVideo(chatId, content.fileId!, content.text);
      case 'document':
        return await this.sendDocument(chatId, content.fileId!, content.text);
      case 'animation':
        return await this.sendAnimation(chatId, content.fileId!, content.text);
      case 'media_group':
        return await this.sendMediaGroup(chatId, content.mediaGroup!, content.text);
      case 'text':
        return await this.sendText(chatId, content.text!);
      default:
        throw new Error(`Unsupported content type: ${(content as unknown as { type: string }).type}`);
    }
  }

  async sendPhoto(chatId: number | string, fileId: string, caption?: string): Promise<number> {
    const result = await this.api.sendPhoto(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
    });
    return result.message_id;
  }

  async sendVideo(chatId: number | string, fileId: string, caption?: string): Promise<number> {
    const result = await this.api.sendVideo(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
    });
    return result.message_id;
  }

  async sendDocument(chatId: number | string, fileId: string, caption?: string): Promise<number> {
    const result = await this.api.sendDocument(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
    });
    return result.message_id;
  }

  async sendAnimation(chatId: number | string, fileId: string, caption?: string): Promise<number> {
    const result = await this.api.sendAnimation(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
    });
    return result.message_id;
  }

  async sendText(chatId: number | string, text: string): Promise<number> {
    const result = await this.api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
    });
    return result.message_id;
  }

  async sendMediaGroup(
    chatId: number | string,
    mediaGroup: MediaGroupItem[],
    caption?: string
  ): Promise<number> {
    const ids = await this.sendMediaGroupAll(chatId, mediaGroup, caption);
    return ids[0];
  }

  /**
   * Send a media group and return ALL message IDs (one per album item).
   * Use this when you need to track every message for later cleanup.
   */
  async sendMediaGroupAll(
    chatId: number | string,
    mediaGroup: MediaGroupItem[],
    caption?: string
  ): Promise<number[]> {
    if (!mediaGroup || mediaGroup.length === 0) {
      throw new Error('Media group cannot be empty');
    }

    const media = mediaGroup.map((item: MediaGroupItem, index: number) => {
      const baseMedia = {
        media: item.fileId,
        caption: index === 0 ? caption : undefined,
        parse_mode: index === 0 ? ('HTML' as const) : undefined,
      };

      if (item.type === 'photo') {
        return { type: 'photo' as const, ...baseMedia };
      } else {
        return { type: 'video' as const, ...baseMedia };
      }
    });

    const result = await this.api.sendMediaGroup(chatId, media);
    return result.map((m) => m.message_id);
  }
}
