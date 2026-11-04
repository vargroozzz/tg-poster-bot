import { ScheduledPostRepository } from '../../database/repositories/scheduled-post.repository.js';
import type { IScheduledPost } from '../../database/models/scheduled-post.model.js';
import { findNicknameByUserId } from '../../shared/helpers/nickname.helper.js';
import { logger } from '../../utils/logger.js';

const PAGE_SIZE = 5;

export interface QueuePage {
  posts: IScheduledPost[];
  labels: string[];
  totalCount: number;
  totalPages: number;
  page: number;
}

export class QueueService {
  private repository = new ScheduledPostRepository();

  async getChannelQueuePage(channelId: string, page: number): Promise<QueuePage> {
    const [posts, totalCount] = await Promise.all([
      this.repository.findPendingByChannelPaginated(channelId, page, PAGE_SIZE),
      this.repository.countPendingByChannel(channelId),
    ]);

    const labels = await Promise.all(posts.map((post) => this.getSourceLabel(post)));
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

    return { posts, labels, totalCount, totalPages, page };
  }

  // keepReplies: the caller re-points the replies waiting on this post itself (a channel move).
  async deleteAndCascade(
    postId: string,
    { keepReplies = false } = {}
  ): Promise<{ channelId: string; deletedTime: Date; keptReplies: number } | null> {
    const post = await this.repository.findById(postId);
    if (!post) return null;

    const { targetChannelId: channelId, scheduledTime: deletedTime } = post;

    // Conditional on the post still being pending: a post the worker published while the
    // user sat in the queue or the edit flow must not be erased, nor its successors shifted.
    // ponytail: the worker flips to 'posted' only after sending, so a post going out right
    // now still reads pending — claim posts up front if that window ever bites.
    if (!(await this.repository.deletePending(postId))) return null;

    await this.repository.shiftPostsEarlier(channelId, deletedTime);
    // The post is gone either way: a failure here must not report the delete as failed.
    const keptReplies = keepReplies
      ? 0
      : await this.repository.releaseOrphanedReplies(post).catch((error: unknown) => {
          logger.error(`Failed to release the replies of deleted post ${postId}:`, error);
          return 0;
        });

    logger.info(`Deleted post ${postId}, shifted later posts for channel ${channelId} back one slot`);
    return { channelId, deletedTime, keptReplies };
  }

  private async getSourceLabel(post: IScheduledPost): Promise<string> {
    const { fromChannelTitle, fromChannelUsername, fromUserId } = post.originalForward;

    if (fromChannelTitle != null || fromChannelUsername != null) {
      return `via ${fromChannelTitle ?? `@${fromChannelUsername}`}`;
    }

    if (fromUserId) {
      const nickname = await findNicknameByUserId(fromUserId);
      if (nickname) return `via ${nickname}`;
    }

    return '(original)';
  }
}
