import { BaseRepository } from './base.repository.js';
import { ScheduledPost, QUEUED_STATUSES, type IScheduledPost, type EmbeddedReplyData } from '../models/scheduled-post.model.js';
import type { RetryMetadata } from '../models/scheduled-post.model.js';
import type { MessageContent, TextHandling, TransformAction } from '../../types/message.types.js';
import { getPostInterval } from '../../utils/post-interval.js';

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
   * Find the posts still holding a slot for a channel (pending + replies waiting on a parent).
   */
  async findPendingByChannel(channelId: string): Promise<IScheduledPost[]> {
    return await this.model
      .find({
        targetChannelId: channelId,
        status: { $in: QUEUED_STATUSES },
      })
      .sort({ scheduledTime: 1 });
  }

  /**
   * Mark a post as successfully posted
   */
  /**
   * Delete a post only while it still holds a slot. Returns false once the worker has
   * published it, so a delete can't erase a post that already went out.
   */
  async deletePending(postId: string): Promise<boolean> {
    return (await this.model.findOneAndDelete({
      _id: postId,
      status: { $in: QUEUED_STATUSES },
    })) !== null;
  }

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
   * Find the slot-holding posts for a channel with pagination
   */
  async findPendingByChannelPaginated(
    channelId: string,
    page: number,
    pageSize: number = 5
  ): Promise<IScheduledPost[]> {
    return await this.model
      .find({ targetChannelId: channelId, status: { $in: QUEUED_STATUSES } })
      .sort({ scheduledTime: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize);
  }

  /**
   * Count the slot-holding posts for a channel
   */
  async countPendingByChannel(channelId: string): Promise<number> {
    return await this.count({ targetChannelId: channelId, status: { $in: QUEUED_STATUSES } });
  }

  /**
   * Close the gap left by a deleted post: pull every later post of the channel back by one
   * slot. The shift must use the channel's own interval — a fixed 30 minutes would land a
   * 15-minute queue in the past and a 60-minute queue on top of the deleted slot.
   * ponytail: a plain subtraction can land a post inside the sleep window; /repack fixes it.
   */
  async shiftPostsEarlier(channelId: string, afterTime: Date): Promise<void> {
    const intervalMinutes = await getPostInterval(channelId);

    await this.model.updateMany(
      { targetChannelId: channelId, status: { $in: QUEUED_STATUSES }, scheduledTime: { $gt: afterTime } },
      [{ $set: { scheduledTime: { $subtract: ['$scheduledTime', intervalMinutes * 60 * 1000] } } }]
    );
  }

  /**
   * Update content and scheduling parameters of a pending post in-place.
   * scheduledTime is intentionally not touched.
   * Only updates a post that still holds a slot, so an already-published post is never touched.
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
      textAbove?: boolean;
      spoilers?: boolean[];
    }
  ): Promise<IScheduledPost | null> {
    // Mongoose drops undefined from an update, so a field the edit cleared (customText, once
    // the user picks the original text again) has to be $unset to actually go away.
    const entries = Object.entries(updates);
    const unset = Object.fromEntries(
      entries.filter(([, value]) => value === undefined).map(([key]) => [key, ''])
    );

    return await this.model.findOneAndUpdate(
      { _id: postId, status: { $in: QUEUED_STATUSES } },
      {
        $set: Object.fromEntries(entries.filter(([, value]) => value !== undefined)),
        ...(Object.keys(unset).length > 0 && { $unset: unset }),
      },
      { new: true }
    );
  }

  /**
   * Set embeddedReply on a parent post that still holds a slot.
   * Returns null if the post was already published.
   */
  async attachEmbeddedReply(
    parentPostId: string,
    replyData: EmbeddedReplyData
  ): Promise<IScheduledPost | null> {
    return await this.model.findOneAndUpdate(
      { _id: parentPostId, status: { $in: QUEUED_STATUSES } },
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

  /**
   * Re-point replies at a parent that was re-created under a new id (channel move).
   * They follow the parent's channel — a reply must live in the same chat as the message
   * it answers.
   * ponytail: keeps each reply's own slot, which can collide with the new channel's queue.
   */
  async reparentSeparatedReplies(
    oldParentPostId: string,
    newParentPostId: string,
    newChannelId: string
  ): Promise<void> {
    await this.model.updateMany(
      { parentPostId: oldParentPostId, status: 'waiting_parent' },
      { $set: { parentPostId: newParentPostId, targetChannelId: newChannelId } }
    );
  }
}
