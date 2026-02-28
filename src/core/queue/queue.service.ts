import { ScheduledPostRepository } from '../../database/repositories/scheduled-post.repository.js';
import type { IScheduledPost } from '../../database/models/scheduled-post.model.js';
import { NicknameHelper } from '../../shared/helpers/nickname.helper.js';
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

  async deleteAndCascade(postId: string): Promise<{ channelId: string; deletedTime: Date } | null> {
    const post = await this.repository.findById(postId);
    if (!post) return null;

    const { targetChannelId: channelId, scheduledTime: deletedTime } = post;

    await this.repository.delete(postId);
    await this.repository.shiftPostsEarlier(channelId, deletedTime);

    logger.info(`Deleted post ${postId}, shifted later posts for channel ${channelId} by -30 min`);
    return { channelId, deletedTime };
  }

  private async getSourceLabel(post: IScheduledPost): Promise<string> {
    const { fromChannelTitle, fromChannelUsername, fromUserId } = post.originalForward;

    if (fromChannelTitle != null || fromChannelUsername != null) {
      return `via ${fromChannelTitle ?? `@${fromChannelUsername}`}`;
    }

    if (fromUserId) {
      const nickname = await NicknameHelper.findNicknameByUserId(fromUserId);
      if (nickname) return `via ${nickname}`;
    }

    return '(original)';
  }
}
