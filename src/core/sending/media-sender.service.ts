import { Api } from 'grammy';
import type { MessageContent, MediaGroupItem } from '../../types/message.types.js';

type ReplyParams = { chatId: number; messageId: number };

const replyOpts = (replyParameters?: ReplyParams) =>
  replyParameters
    ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
    : {};

// Telegram's show_caption_above_media only exists on photo, video and animation (and on
// those same types inside an album, where only the first item carries the caption).
const ABOVE_CAPABLE = ['photo', 'video', 'animation'];

/** Whether this content can carry its caption above the media at all. */
export const supportsTextAbove = (content: MessageContent): boolean =>
  !!('text' in content && content.text) &&
  (ABOVE_CAPABLE.includes(content.type) ||
    (content.type === 'media_group' && ABOVE_CAPABLE.includes(content.mediaGroup[0]?.type)));

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
  async sendMessage(
    chatId: number | string,
    content: MessageContent,
    replyParameters?: ReplyParams,
    textAbove?: boolean
  ): Promise<number> {
    switch (content.type) {
      case 'photo':
        return await this.sendPhoto(chatId, content.fileId, content.text, replyParameters, content.hasSpoiler, textAbove);
      case 'video':
        return await this.sendVideo(chatId, content.fileId, content.text, replyParameters, content.hasSpoiler, textAbove);
      case 'document':
        return await this.sendDocument(chatId, content.fileId, content.text, replyParameters);
      case 'animation':
        return await this.sendAnimation(chatId, content.fileId, content.text, replyParameters, content.hasSpoiler, textAbove);
      case 'voice':
        return await this.sendVoice(chatId, content.fileId, content.text, replyParameters);
      case 'audio':
        return await this.sendAudio(chatId, content.fileId, content.text, replyParameters);
      // Caption-less types: Telegram accepts no caption on these, so any transformed
      // text/attribution is dropped rather than sent as a second message.
      // A transformed dice is re-sent, so it rolls a new value; forward keeps the original.
      case 'video_note':
        return (await this.api.sendVideoNote(chatId, content.fileId, replyOpts(replyParameters))).message_id;
      case 'sticker':
        return (await this.api.sendSticker(chatId, content.fileId, replyOpts(replyParameters))).message_id;
      case 'dice':
        return (await this.api.sendDice(chatId, content.emoji, replyOpts(replyParameters))).message_id;
      case 'contact':
        return (
          await this.api.sendContact(chatId, content.phoneNumber, content.firstName, {
            last_name: content.lastName,
            vcard: content.vcard,
            ...replyOpts(replyParameters),
          })
        ).message_id;
      case 'location':
        return (
          await this.api.sendLocation(chatId, content.latitude, content.longitude, replyOpts(replyParameters))
        ).message_id;
      case 'venue':
        return (
          await this.api.sendVenue(
            chatId,
            content.latitude,
            content.longitude,
            content.title,
            content.address,
            replyOpts(replyParameters)
          )
        ).message_id;
      case 'media_group':
        return await this.sendMediaGroup(chatId, content.mediaGroup, content.text, replyParameters, textAbove);
      case 'text':
        return await this.sendText(chatId, content.text, replyParameters, content.linkPreviewOptions);
      default:
        throw new Error(`Unsupported content type: ${(content as unknown as { type: string }).type}`);
    }
  }

  async sendPhoto(
    chatId: number | string,
    fileId: string,
    caption?: string,
    replyParameters?: ReplyParams,
    hasSpoiler?: boolean,
    textAbove?: boolean
  ): Promise<number> {
    const result = await this.api.sendPhoto(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
      ...(hasSpoiler ? { has_spoiler: true } : {}),
      ...(textAbove ? { show_caption_above_media: true } : {}),
      ...(replyParameters
        ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
        : {}),
    });
    return result.message_id;
  }

  async sendVideo(
    chatId: number | string,
    fileId: string,
    caption?: string,
    replyParameters?: ReplyParams,
    hasSpoiler?: boolean,
    textAbove?: boolean
  ): Promise<number> {
    const result = await this.api.sendVideo(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
      ...(hasSpoiler ? { has_spoiler: true } : {}),
      ...(textAbove ? { show_caption_above_media: true } : {}),
      ...(replyParameters
        ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
        : {}),
    });
    return result.message_id;
  }

  async sendDocument(
    chatId: number | string,
    fileId: string,
    caption?: string,
    replyParameters?: ReplyParams
  ): Promise<number> {
    const result = await this.api.sendDocument(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
      ...(replyParameters
        ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
        : {}),
    });
    return result.message_id;
  }

  async sendAnimation(
    chatId: number | string,
    fileId: string,
    caption?: string,
    replyParameters?: ReplyParams,
    hasSpoiler?: boolean,
    textAbove?: boolean
  ): Promise<number> {
    const result = await this.api.sendAnimation(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
      ...(hasSpoiler ? { has_spoiler: true } : {}),
      ...(textAbove ? { show_caption_above_media: true } : {}),
      ...(replyParameters
        ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
        : {}),
    });
    return result.message_id;
  }

  async sendVoice(
    chatId: number | string,
    fileId: string,
    caption?: string,
    replyParameters?: ReplyParams
  ): Promise<number> {
    const result = await this.api.sendVoice(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
      ...(replyParameters
        ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
        : {}),
    });
    return result.message_id;
  }

  async sendAudio(
    chatId: number | string,
    fileId: string,
    caption?: string,
    replyParameters?: ReplyParams
  ): Promise<number> {
    const result = await this.api.sendAudio(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
      ...replyOpts(replyParameters),
    });
    return result.message_id;
  }

  async sendText(
    chatId: number | string,
    text: string,
    replyParameters?: ReplyParams,
    linkPreviewOptions?: { is_disabled?: boolean }
  ): Promise<number> {
    const result = await this.api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      link_preview_options: linkPreviewOptions ?? { is_disabled: true },
      ...(replyParameters
        ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
        : {}),
    });
    return result.message_id;
  }

  async sendMediaGroup(
    chatId: number | string,
    mediaGroup: MediaGroupItem[],
    caption?: string,
    replyParameters?: ReplyParams,
    textAbove?: boolean
  ): Promise<number> {
    const ids = await this.sendMediaGroupAll(chatId, mediaGroup, caption, replyParameters, textAbove);
    return ids[0];
  }

  /**
   * Send a media group and return ALL message IDs (one per album item).
   * Use this when you need to track every message for later cleanup.
   */
  async sendMediaGroupAll(
    chatId: number | string,
    mediaGroup: MediaGroupItem[],
    caption?: string,
    replyParameters?: ReplyParams,
    textAbove?: boolean
  ): Promise<number[]> {
    if (!mediaGroup || mediaGroup.length === 0) {
      throw new Error('Media group cannot be empty');
    }

    const media = mediaGroup.map((item: MediaGroupItem, index: number) => ({
      type: item.type,
      media: item.fileId,
      caption: index === 0 ? caption : undefined,
      parse_mode: index === 0 ? ('HTML' as const) : undefined,
      // Only the captioned item can place its caption above the album.
      ...(textAbove && index === 0 ? { show_caption_above_media: true } : {}),
      ...(item.hasSpoiler ? { has_spoiler: true } : {}),
    }));

    const result = await this.api.sendMediaGroup(chatId, media, {
      ...(replyParameters
        ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
        : {}),
    });
    return result.map((m) => m.message_id);
  }
}
