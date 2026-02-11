import { Api } from 'grammy';
import type { IScheduledPost } from '../../database/models/scheduled-post.model.js';
import type { MediaGroupItem } from '../../types/message.types.js';

/**
 * Service for publishing posts to Telegram
 * Extracted from PostWorkerService to handle only publishing logic
 */
export class PostPublisherService {
  constructor(private api: Api) {}

  /**
   * Publish a post to Telegram based on its content type
   * Returns the Telegram message ID of the published message
   */
  async publish(post: IScheduledPost): Promise<number> {
    // For 'forward' action, use copyMessage to preserve "Forwarded from" attribution
    if (post.action === 'forward') {
      return await this.copyMessage(post);
    }

    // For 'transform' action, publish based on content type
    switch (post.content.type) {
      case 'photo':
        return await this.publishPhoto(post);
      case 'video':
        return await this.publishVideo(post);
      case 'document':
        return await this.publishDocument(post);
      case 'animation':
        return await this.publishAnimation(post);
      case 'media_group':
        return await this.publishMediaGroup(post);
      case 'text':
        return await this.publishText(post);
      default:
        throw new Error(`Unsupported content type: ${(post.content as { type: string }).type}`);
    }
  }

  /**
   * Copy message using Telegram's copyMessage API
   */
  private async copyMessage(post: IScheduledPost): Promise<number> {
    if (!post.originalForward.chatId || !post.originalForward.messageId) {
      throw new Error('Missing chatId or messageId for copyMessage');
    }

    const result = await this.api.copyMessage(
      post.targetChannelId,
      post.originalForward.chatId,
      post.originalForward.messageId
    );

    return result.message_id;
  }

  /**
   * Publish a photo message
   */
  private async publishPhoto(post: IScheduledPost): Promise<number> {
    if (!post.content.fileId) {
      throw new Error('Missing fileId for photo');
    }

    const result = await this.api.sendPhoto(post.targetChannelId, post.content.fileId, {
      caption: post.content.text,
      parse_mode: 'HTML',
    });

    return result.message_id;
  }

  /**
   * Publish a video message
   */
  private async publishVideo(post: IScheduledPost): Promise<number> {
    if (!post.content.fileId) {
      throw new Error('Missing fileId for video');
    }

    const result = await this.api.sendVideo(post.targetChannelId, post.content.fileId, {
      caption: post.content.text,
      parse_mode: 'HTML',
    });

    return result.message_id;
  }

  /**
   * Publish a document message
   */
  private async publishDocument(post: IScheduledPost): Promise<number> {
    if (!post.content.fileId) {
      throw new Error('Missing fileId for document');
    }

    const result = await this.api.sendDocument(post.targetChannelId, post.content.fileId, {
      caption: post.content.text,
      parse_mode: 'HTML',
    });

    return result.message_id;
  }

  /**
   * Publish an animation (GIF) message
   */
  private async publishAnimation(post: IScheduledPost): Promise<number> {
    if (!post.content.fileId) {
      throw new Error('Missing fileId for animation');
    }

    const result = await this.api.sendAnimation(post.targetChannelId, post.content.fileId, {
      caption: post.content.text,
      parse_mode: 'HTML',
    });

    return result.message_id;
  }

  /**
   * Publish a text-only message
   */
  private async publishText(post: IScheduledPost): Promise<number> {
    if (!post.content.text) {
      throw new Error('Missing text for text message');
    }

    const result = await this.api.sendMessage(post.targetChannelId, post.content.text, {
      parse_mode: 'HTML',
    });

    return result.message_id;
  }

  /**
   * Publish a media group (album)
   */
  private async publishMediaGroup(post: IScheduledPost): Promise<number> {
    if (!post.content.mediaGroup || post.content.mediaGroup.length === 0) {
      throw new Error('Missing or empty mediaGroup');
    }

    // Build media array for sendMediaGroup
    const media = post.content.mediaGroup.map((item: MediaGroupItem, index: number) => {
      const baseMedia = {
        media: item.fileId,
        // Only first item gets caption
        caption: index === 0 ? post.content.text : undefined,
        parse_mode: index === 0 ? ('HTML' as const) : undefined,
      };

      if (item.type === 'photo') {
        return { type: 'photo' as const, ...baseMedia };
      } else {
        return { type: 'video' as const, ...baseMedia };
      }
    });

    const result = await this.api.sendMediaGroup(post.targetChannelId, media);

    // For media groups, result is an array, return first message ID
    return result[0].message_id;
  }
}
