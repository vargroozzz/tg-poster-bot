import { BaseRepository } from './base.repository.js';
import { ScheduledPost, QUEUED_STATUSES, WAITING_PARENT, POSTED, FAILED, HOLDS_SLOT, type IScheduledPost, type PostSlot } from '../models/scheduled-post.model.js';
import type { RetryMetadata } from '../models/scheduled-post.model.js';
import type { MessageContent, TextHandling, TransformAction } from '../../types/message.types.js';
import { getPostInterval } from '../../utils/post-interval.js';
import { findNextAvailableSlot } from '../../utils/time-slots.js';

export const PARENT_FAILED = 'The post it replies to failed to publish';

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
   * Find the posts holding a slot for a channel (pending + replies waiting on a parent),
   * leaving out the same-slot replies that ride along with one.
   */
  async findSlotHoldersByChannel(channelId: string): Promise<IScheduledPost[]> {
    return await this.model
      .find({ targetChannelId: channelId, status: { $in: QUEUED_STATUSES }, ...HOLDS_SLOT })
      .sort({ scheduledTime: 1 });
  }

  /** Move a slot holder to a new time, with the same-slot replies that follow it. */
  async moveSlot(slotPostId: string, scheduledTime: Date): Promise<void> {
    await this.model.updateOne({ _id: slotPostId }, { $set: { scheduledTime } });
    await this.model.updateMany({ slotPostId, sameSlot: true }, { $set: { scheduledTime } });
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
      // A same-slot reply lists right after the post whose slot it shares.
      .sort({ scheduledTime: 1, sameSlot: 1, createdAt: 1 })
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
    const shift = [{ $set: { scheduledTime: { $subtract: ['$scheduledTime', intervalMinutes * 60 * 1000] } } }];

    const holders = await this.model.find(
      { targetChannelId: channelId, status: { $in: QUEUED_STATUSES }, scheduledTime: { $gt: afterTime }, ...HOLDS_SLOT },
      { _id: 1 }
    );
    if (holders.length === 0) return;
    const ids = holders.map((h) => h._id);
    await this.model.updateMany({ _id: { $in: ids } }, shift);
    // Their same-slot replies, in whatever channel, keep the time of the post they follow.
    await this.model.updateMany({ sameSlot: true, slotPostId: { $in: ids.map(String) } }, shift);
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
   * Keep the replies waiting on a deleted post: they take over what it answered (its own
   * queued parent, or a published post), or post on their own if it answered nothing.
   * Returns how many were kept.
   */
  async releaseOrphanedReplies(
    deleted: Pick<IScheduledPost, '_id' | 'parentPostId' | 'replyToMessageId' | 'replyToChannelId'>
  ): Promise<number> {
    const { parentPostId, replyToMessageId, replyToChannelId } = deleted;
    const id = deleted._id.toString();
    if (!replyToMessageId && !parentPostId) return await this.releaseStandalone(id);
    const { modifiedCount } = await this.model.updateMany(
      { parentPostId: id, status: WAITING_PARENT },
      replyToMessageId
        ? { $set: { replyToMessageId, replyToChannelId, status: 'pending' }, $unset: { parentPostId: 1 } }
        : { $set: { parentPostId } }
    );
    if (parentPostId && !replyToMessageId) await this.settleRepliesOf(parentPostId);
    return modifiedCount;
  }

  /** Let the replies waiting on a post that is gone post on their own. Returns how many. */
  private async releaseStandalone(parentPostId: string): Promise<number> {
    const { modifiedCount } = await this.model.updateMany(
      { parentPostId, status: WAITING_PARENT },
      { $set: { status: 'pending' }, $unset: { parentPostId: 1 } }
    );
    return modifiedCount;
  }

  /**
   * Fail the replies waiting on a post that failed, and theirs in turn: none can be sent
   * without it. Returns how many were failed.
   */
  async failWaitingReplies(parentPostId: string, error: string): Promise<number> {
    const children = await this.model.find({ parentPostId, status: WAITING_PARENT }, { _id: 1 });
    if (children.length === 0) return 0;
    await this.model.updateMany(
      { _id: { $in: children.map((c) => c._id) } },
      { $set: { status: FAILED, error } }
    );
    const nested = await Promise.all(children.map((c) => this.failWaitingReplies(c._id.toString(), error)));
    return nested.reduce((sum, n) => sum + n, children.length);
  }

  /**
   * Settle the replies created waiting on a parent that is no longer queued: the worker and
   * the delete only handle replies that exist at that moment. Call it after creating the
   * reply, so a change in between is seen here or there. A published parent releases them, a
   * failed one fails them, a deleted one lets them post on their own. Returns which.
   */
  async settleRepliesOf(parentPostId: string): Promise<'waiting' | 'released' | 'failed' | 'standalone'> {
    const parent = await this.findById(parentPostId);
    if (!parent) {
      await this.releaseStandalone(parentPostId);
      return 'standalone';
    }
    if (parent.status === FAILED) {
      await this.failWaitingReplies(parentPostId, PARENT_FAILED);
      return 'failed';
    }
    if (parent.status === POSTED && parent.telegramScheduledMessageId) {
      await this.unblockSeparatedReplies(parentPostId, parent.telegramScheduledMessageId, parent.targetChannelId);
      return 'released';
    }
    return 'waiting';
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
      { parentPostId, status: WAITING_PARENT },
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
   * A reply in the parent's old channel follows it; one moved to another channel stays there
   * (reply_parameters names the parent's chat, so it may live elsewhere).
   * Same-slot replies that followed its slot follow the new one.
   * ponytail: keeps a separated reply's own slot, which can collide with the new channel's queue.
   */
  async reparentSeparatedReplies(
    oldParentPostId: string,
    newParentPostId: string,
    oldChannelId: string,
    newChannelId: string,
    newSlot: PostSlot
  ): Promise<void> {
    await this.model.updateMany({ parentPostId: oldParentPostId, status: WAITING_PARENT }, [
      {
        $set: {
          parentPostId: newParentPostId,
          targetChannelId: { $cond: [{ $eq: ['$targetChannelId', oldChannelId] }, newChannelId, '$targetChannelId'] },
        },
      },
    ]);
    await this.model.updateMany(
      { slotPostId: oldParentPostId, sameSlot: true },
      { $set: { slotPostId: newSlot.slotPostId, scheduledTime: newSlot.scheduledTime } }
    );
  }

  /** The same-slot replies released by their published parent, in the order they were added. */
  async findDueSameSlotReplies(parentPostId: string): Promise<IScheduledPost[]> {
    return await this.model
      .find({ parentPostId, sameSlot: true, status: 'pending', scheduledTime: { $lte: new Date() } })
      .sort({ createdAt: 1 });
  }

  /** The same-slot replies under a post and theirs in turn, parents before their replies. */
  async findSameSlotSubtree(parentPostId: string): Promise<IScheduledPost[]> {
    const children = await this.model.find({ parentPostId, sameSlot: true, status: WAITING_PARENT }).sort({ createdAt: 1 });
    const nested = await Promise.all(children.map((c) => this.findSameSlotSubtree(c._id.toString())));
    return [...children, ...nested.flat()];
  }

  /** Delete the same-slot replies under a post, theirs in turn. Returns the deleted posts. */
  async deleteSameSlotReplies(parentPostId: string): Promise<IScheduledPost[]> {
    const subtree = await this.findSameSlotSubtree(parentPostId);
    if (subtree.length > 0) {
      await this.model.deleteMany({ _id: { $in: subtree.map((p) => p._id) }, status: WAITING_PARENT });
    }
    return subtree;
  }

  /**
   * A deleted slot holder's same-slot replies each need a slot of their own: the first one in
   * its channel takes the freed slot, the others the next free slot in their channel, never
   * before it. Returns the reply that took the freed slot, or null.
   */
  async promoteSameSlotReplies(
    deleted: Pick<IScheduledPost, '_id' | 'targetChannelId' | 'scheduledTime'>
  ): Promise<IScheduledPost | null> {
    const children = await this.model
      .find({ parentPostId: deleted._id.toString(), sameSlot: true, status: WAITING_PARENT })
      .sort({ createdAt: 1 });
    const heir = children.find((c) => c.targetChannelId === deleted.targetChannelId);
    const others = children.filter((c) => c !== heir);
    // Sequential, heir first: each next free slot is found after the ones taken before it.
    if (heir) await this.takeOwnSlot(heir._id.toString(), heir.targetChannelId, { at: deleted.scheduledTime });
    await others.reduce(
      (previous, child) =>
        previous.then(async () => {
          await this.takeOwnSlot(child._id.toString(), child.targetChannelId, { notBefore: deleted.scheduledTime });
        }),
      Promise.resolve()
    );
    return heir ?? null;
  }

  /**
   * Make a same-slot reply hold a slot of its own: `at`, or the next free one not before
   * `notBefore`. The same-slot replies under it follow it. Returns its time.
   */
  async takeOwnSlot(
    postId: string,
    targetChannelId: string,
    { at, notBefore }: { at?: Date; notBefore?: Date }
  ): Promise<Date> {
    const scheduledTime = at ?? (await findNextAvailableSlot(targetChannelId, notBefore));
    await this.model.updateOne({ _id: postId }, { $set: { sameSlot: false, scheduledTime }, $unset: { slotPostId: 1 } });
    const followers = await this.findSameSlotSubtree(postId);
    if (followers.length > 0) {
      await this.model.updateMany(
        { _id: { $in: followers.map((f) => f._id) } },
        { $set: { slotPostId: postId, scheduledTime } }
      );
    }
    return scheduledTime;
  }
}
