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

  /**
   * keepReplies: the caller re-points the replies waiting on this post itself (a channel move).
   * dropSameSlot: delete the same-slot replies under it too, rather than keep them.
   */
  async deleteAndCascade(
    postId: string,
    { keepReplies = false, dropSameSlot = false } = {}
  ): Promise<{ channelId: string; deletedTime: Date; keptReplies: number; droppedReplies: number } | null> {
    const post = await this.repository.findById(postId);
    if (!post) return null;

    const { targetChannelId: channelId, scheduledTime: deletedTime } = post;

    // Conditional on the post still being pending: a post the worker published while the
    // user sat in the queue or the edit flow must not be erased, nor its successors shifted.
    // ponytail: the worker flips to 'posted' only after sending, so a post going out right
    // now still reads pending — claim posts up front if that window ever bites.
    if (!(await this.repository.deletePending(postId))) return null;

    if (keepReplies) {
      if (!post.sameSlot) await this.repository.shiftPostsEarlier(channelId, deletedTime);
      logger.info(`Deleted post ${postId} for a move`);
      return { channelId, deletedTime, keptReplies: 0, droppedReplies: 0 };
    }

    // The post is gone either way: a failure from here on must not report the delete as failed.
    const settle = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> =>
      run().catch((error: unknown) => {
        logger.error(`Failed to ${what} of deleted post ${postId}:`, error);
        return fallback;
      });

    const dropped = dropSameSlot
      ? await settle('delete the same-slot replies', () => this.repository.deleteSameSlotReplies(postId), [])
      : [];
    // A same-slot post holds no slot, and a reply that took the freed one leaves no gap. A
    // failed promotion may have moved the heir already, so it shifts nothing either.
    const heir =
      post.sameSlot || dropSameSlot
        ? null
        : await settle('promote the same-slot replies', () => this.repository.promoteSameSlotReplies(post), undefined);
    if (!post.sameSlot && heir !== undefined && heir?.targetChannelId !== channelId) {
      await this.repository.shiftPostsEarlier(channelId, deletedTime);
    }

    // Separated replies to a dropped reply are kept: they post on their own. Sequential, the
    // post first: a dropped reply's release can let go of whatever still waits on the post.
    const keptReplies = await [post, ...dropped].reduce(
      async (sum, p) => (await sum) + (await settle('release the replies', () => this.repository.releaseOrphanedReplies(p), 0)),
      Promise.resolve(0)
    );

    logger.info(`Deleted post ${postId} (${keptReplies} repl${keptReplies === 1 ? 'y' : 'ies'} kept, ${dropped.length} dropped)`);
    return { channelId, deletedTime, keptReplies, droppedReplies: dropped.length };
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
