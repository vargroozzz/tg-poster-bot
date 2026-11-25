import { Api } from 'grammy';
import type { IScheduledPost } from '../../database/models/scheduled-post.model.js';
import { MediaSenderService } from '../sending/media-sender.service.js';
import { withSpoilers } from '../sending/spoilers.js';
import { createQueuePreviewActionKeyboard } from '../../bot/keyboards/queue-preview-action.keyboard.js';
import { logger } from '../../utils/logger.js';

export class QueuePreviewSenderService {
  private mediaSender: MediaSenderService;

  constructor(private api: Api) {
    this.mediaSender = new MediaSenderService(api);
  }

  async sendPreview(
    userId: number,
    post: IScheduledPost
  ): Promise<{ previewMessageIds: number[]; controlMessageId: number }> {
    const previewMessageIds: number[] = [];

    if (post.action === 'forward') {
      const { chatId, messageId, mediaGroupMessageIds, replyChainMessageIds } = post.originalForward;

      const bulkIds =
        replyChainMessageIds && replyChainMessageIds.length > 1
          ? replyChainMessageIds
          : mediaGroupMessageIds && mediaGroupMessageIds.length > 1
            ? mediaGroupMessageIds
            : null;

      if (bulkIds) {
        try {
          const result = await this.api.forwardMessages(userId, chatId, bulkIds);
          previewMessageIds.push(...result.map((r) => r.message_id));
        } catch (error) {
          logger.error('Failed to forward bulk messages for queue preview:', error);
          const fallback = await this.api.sendMessage(userId, '⚠️ Preview unavailable for this post');
          previewMessageIds.push(fallback.message_id);
        }
      } else {
        try {
          const result = await this.api.forwardMessage(userId, chatId, messageId);
          previewMessageIds.push(result.message_id);
        } catch (error) {
          logger.error('Failed to forward message for queue preview:', error);
          const fallback = await this.api.sendMessage(userId, '⚠️ Preview unavailable for this post');
          previewMessageIds.push(fallback.message_id);
        }
      }
    } else {
      // Transform action: send the already-transformed content from DB as-is
      const content = withSpoilers(post.content, post.spoilers);
      previewMessageIds.push(...(await this.mediaSender.sendAll(userId, content, undefined, post.textAbove)));
    }

    const keyboard = createQueuePreviewActionKeyboard(post._id.toString());
    const controlMsg = await this.api.sendMessage(userId, 'Previewing scheduled post:', {
      reply_markup: keyboard,
    });

    logger.debug(`Queue preview sent to user ${userId}, control msg: ${controlMsg.message_id}`);
    return { previewMessageIds, controlMessageId: controlMsg.message_id };
  }
}
