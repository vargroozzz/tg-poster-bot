import { Api } from 'grammy';
import type { IScheduledPost } from '../../database/models/scheduled-post.model.js';
import { MediaSenderService } from '../sending/media-sender.service.js';
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
        (replyChainMessageIds?.length ?? 0) > 1
          ? replyChainMessageIds!
          : (mediaGroupMessageIds?.length ?? 0) > 1
            ? mediaGroupMessageIds!
            : null;

      if (bulkIds) {
        try {
          const result = (await this.api.raw.forwardMessages({
            chat_id: userId,
            from_chat_id: chatId,
            message_ids: bulkIds,
          })) as Array<{ message_id: number }>;
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
      if (post.content.type === 'media_group' && post.content.mediaGroup?.length) {
        const ids = await this.mediaSender.sendMediaGroupAll(
          userId,
          post.content.mediaGroup,
          post.content.text
        );
        previewMessageIds.push(...ids);
      } else {
        const id = await this.mediaSender.sendMessage(userId, post.content);
        previewMessageIds.push(id);
      }
    }

    const keyboard = createQueuePreviewActionKeyboard(post._id.toString());
    const controlMsg = await this.api.sendMessage(userId, 'Previewing scheduled post:', {
      reply_markup: keyboard,
    });

    logger.debug(`Queue preview sent to user ${userId}, control msg: ${controlMsg.message_id}`);
    return { previewMessageIds, controlMessageId: controlMsg.message_id };
  }
}
