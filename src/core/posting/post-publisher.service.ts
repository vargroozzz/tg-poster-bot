import { Api } from 'grammy';
import type { IScheduledPost } from '../../database/models/scheduled-post.model.js';
import { MediaSenderService } from '../sending/media-sender.service.js';

/**
 * Service for publishing posts to Telegram
 * Extracted from PostWorkerService to handle only publishing logic
 */
export class PostPublisherService {
  private mediaSender: MediaSenderService;

  constructor(private api: Api) {
    this.mediaSender = new MediaSenderService(api);
  }

  /**
   * Publish a post to Telegram based on its content type
   * Returns the Telegram message ID of the published message
   */
  async publish(post: IScheduledPost): Promise<number> {
    // For 'forward' action, use forwardMessage to preserve "Forwarded from" attribution
    if (post.action === 'forward') {
      return await this.copyMessage(post);
    }

    // For 'transform' action, delegate to MediaSenderService
    return await this.mediaSender.sendMessage(post.targetChannelId, post.content);
  }

  /**
   * Forward message using Telegram's forwardMessage(s) API
   * This preserves the "Forwarded from" attribution
   * For media groups, forwards all messages atomically to preserve the album
   */
  private async copyMessage(post: IScheduledPost): Promise<number> {
    if (!post.originalForward.chatId || !post.originalForward.messageId) {
      throw new Error('Missing chatId or messageId for forwardMessage');
    }

    // For reply chains or media groups, forward all messages atomically
    const bulkMessageIds =
      (post.originalForward.replyChainMessageIds?.length ?? 0) > 1
        ? post.originalForward.replyChainMessageIds
        : (post.originalForward.mediaGroupMessageIds?.length ?? 0) > 1
          ? post.originalForward.mediaGroupMessageIds
          : null;

    if (bulkMessageIds) {
      const result = (await this.api.raw.forwardMessages({
        chat_id: post.targetChannelId,
        from_chat_id: post.originalForward.chatId,
        message_ids: bulkMessageIds,
      })) as Array<{ message_id: number }>;

      return result[0].message_id;
    }

    // Single message forward
    const result = await this.api.forwardMessage(
      post.targetChannelId,
      post.originalForward.chatId,
      post.originalForward.messageId
    );

    return result.message_id;
  }
}
