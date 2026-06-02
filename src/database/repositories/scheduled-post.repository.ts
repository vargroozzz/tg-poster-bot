import { BaseRepository } from './base.repository.js';
import { ScheduledPost, type IScheduledPost, type EmbeddedReplyData } from '../models/scheduled-post.model.js';
import type { RetryMetadata } from '../models/scheduled-post.model.js';
import type { MessageContent, TextHandling, TransformAction } from '../../types/message.types.js';

/**
 * Repository for scheduled posts
 * Provides specialized queries for post scheduling and publishing
 */
export class ScheduledPostRepository extends BaseRepository<IScheduledPost> {
  constructor() {
    super(ScheduledPost);
  }

  /**
   * Find posts that are due for publishing
   * Returns posts where status is 'pending' and scheduledTime has passed
   */
  async findDuePosts(limit: number = 10): Promise<IScheduledPost[]> {
    const now = new Date();
    return await this.model
      .find({
        status: 'pending',
        scheduledTime: { $lte: now },
      })
      .sort({ scheduledTime: 1 })
      .limit(limit);
  }

  /**
   * Find posts scheduled for a specific channel
   */
  async findByChannel(channelId: string): Promise<IScheduledPost[]> {
    return await this.model
      .find({ targetChannelId: channelId })
      .sort({ scheduledTime: 1 });
  }

  /**
   * Find pending posts for a specific channel
   */
  async findPendingByChannel(channelId: string): Promise<IScheduledPost[]> {
    return await this.model
      .find({
        targetChannelId: channelId,
        status: 'pending',
      })
      .sort({ scheduledTime: 1 });
  }

  /**
   * Mark a post as successfully posted
   */
  async markPosted(postId: string, telegramMessageId: number): Promise<void> {
    await this.model.findByIdAndUpdate(postId, {
      status: 'posted',
      postedAt: new Date(),
      telegramScheduledMessageId: telegramMessageId,
    });
  }

  /**
   * Mark a post as failed with error details
   */
  async markFailed(postId: string, error: string, retryMetadata?: RetryMetadata): Promise<void> {
    const update: Partial<IScheduledPost> = {
      status: 'failed',
      error,
    };

    if (retryMetadata) {
      update.retryMetadata = retryMetadata;
    }

    await this.model.findByIdAndUpdate(postId, update);
  }

  /**
   * Get statistics about scheduled posts
   */
  async getStats(): Promise<{
    pending: number;
    posted: number;
    failed: number;
    total: number;
  }> {
    const [pending, posted, failed, total] = await Promise.all([
      this.count({ status: 'pending' }),
      this.count({ status: 'posted' }),
      this.count({ status: 'failed' }),
      this.count({}),
    ]);

    return { pending, posted, failed, total };
  }

  /**
   * Find the next available time slot for a channel
   * Returns the most recent scheduled time for the channel
   */
  async findLatestScheduledTime(channelId: string): Promise<Date | null> {
    const latestPost = await this.model
      .findOne({ targetChannelId: channelId })
      .sort({ scheduledTime: -1 })
      .select('scheduledTime');

    return latestPost?.scheduledTime ?? null;
  }

  /**
   * Find pending posts for a channel with pagination
   */
  async findPendingByChannelPaginated(
    channelId: string,
    page: number,
    pageSize: number = 5
  ): Promise<IScheduledPost[]> {
    return await this.model
      .find({ targetChannelId: channelId, status: 'pending' })
      .sort({ scheduledTime: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize);
  }

  /**
   * Count pending posts for a channel
   */
  async countPendingByChannel(channelId: string): Promise<number> {
    return await this.count({ targetChannelId: channelId, status: 'pending' });
  }

  /**
   * Shift all pending posts for a channel earlier by 30 minutes
   * Used to fill the gap after a post is deleted
   */
  async shiftPostsEarlier(channelId: string, afterTime: Date): Promise<void> {
    await this.model.updateMany(
      { targetChannelId: channelId, status: 'pending', scheduledTime: { $gt: afterTime } },
      [{ $set: { scheduledTime: { $subtract: ['$scheduledTime', 30 * 60 * 1000] } } }]
    );
  }

  /**
   * Update content and scheduling parameters of a pending post in-place.
   * scheduledTime is intentionally not touched.
   * Only updates posts with status 'pending' to prevent updating already-published posts.
   * Returns the updated document if successful, or null if the post was already published.
   */
  async updatePost(
    postId: string,
    updates: {
      content: MessageContent;
      action: TransformAction;
      rawContent: MessageContent;
      textHandling?: TextHandling;
      selectedUserId?: number | null;
      customText?: string;
    }
  ): Promise<IScheduledPost | null> {
    return await this.model.findOneAndUpdate(
      { _id: postId, status: 'pending' },
      { $set: updates },
      { new: true }
    );
  }

  /**
   * Set embeddedReply on a pending parent post.
   * Only updates posts with status 'pending' — returns null if already published.
   */
  async attachEmbeddedReply(
    parentPostId: string,
    replyData: EmbeddedReplyData
  ): Promise<IScheduledPost | null> {
    return await this.model.findOneAndUpdate(
      { _id: parentPostId, status: 'pending' },
      { $set: { embeddedReply: replyData } },
      { new: true }
    );
  }

  /**
   * Convert a freshly-created pending post into a separated reply.
   * If the parent is already posted, fills replyToMessageId/replyToChannelId and keeps status 'pending'.
   * If the parent is still pending, sets status to 'waiting_parent'.
   */
  async convertToSeparatedReply(
    postId: string,
    parentPostId: string,
    parentPost: IScheduledPost | null
  ): Promise<void> {
    const update: Record<string, unknown> = { parentPostId };

    if (parentPost?.status === 'posted' && parentPost.telegramScheduledMessageId) {
      update.replyToMessageId = parentPost.telegramScheduledMessageId;
      update.replyToChannelId = parentPost.targetChannelId;
    } else {
      update.status = 'waiting_parent';
    }

    await this.model.findByIdAndUpdate(postId, { $set: update });
  }

  /**
   * After the parent post publishes, fill in the reply link and flip status to 'pending'.
   */
  async unblockSeparatedReplies(
    parentPostId: string,
    parentMessageId: number,
    parentChannelId: string
  ): Promise<void> {
    await this.model.updateMany(
      { parentPostId, status: 'waiting_parent' },
      {
        $set: {
          replyToMessageId: parentMessageId,
          replyToChannelId: parentChannelId,
          status: 'pending',
        },
      }
    );
  }
}
