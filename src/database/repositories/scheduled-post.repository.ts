import { BaseRepository } from './base.repository.js';
import { ScheduledPost, type IScheduledPost } from '../models/scheduled-post.model.js';
import type { RetryMetadata } from '../models/scheduled-post.model.js';

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
}
