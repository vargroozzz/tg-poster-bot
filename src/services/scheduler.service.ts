import { Api } from 'grammy';
import { Message } from 'grammy/types';
import { ScheduledPost } from '../database/models/scheduled-post.model.js';
import { getTargetChannelId } from '../database/models/bot-settings.model.js';
import type { ForwardInfo, MessageContent, TransformAction } from '../types/message.types.js';
import type { ScheduledPostInfo } from '../types/schedule.types.js';
import { findNextAvailableSlot, formatSlotTime } from '../utils/time-slots.js';
import { logger } from '../utils/logger.js';

export class SchedulerService {
  constructor(_api: Api) {} // Keep for compatibility but not used anymore

  /**
   * Schedule a post to the target channel
   */
  async schedulePost(
    originalMessage: Message,
    forwardInfo: ForwardInfo,
    action: TransformAction,
    transformedContent: MessageContent,
    targetChannelId: string
  ): Promise<ScheduledPostInfo> {
    if (!targetChannelId) {
      throw new Error('No target channel provided.');
    }

    // Find next available time slot
    const scheduledTime = await findNextAvailableSlot(targetChannelId);

    logger.info(
      `Scheduling ${transformedContent.type} post for ${formatSlotTime(scheduledTime)} (${targetChannelId})`
    );

    try {
      // Save to MongoDB - will be posted by background worker at scheduled time
      const post = await ScheduledPost.create({
        scheduledTime,
        targetChannelId,
        originalForward: forwardInfo,
        content: transformedContent,
        action,
        status: 'pending',
        createdAt: new Date(),
      });

      logger.info(`Post scheduled successfully with ID ${post._id}`);

      return {
        scheduledTime,
        postId: post._id.toString(),
      };
    } catch (error) {
      // Check if it's a MongoDB duplicate key error
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
        logger.warn('Slot collision detected, retrying with next slot');
        // Retry with the next slot
        return this.schedulePost(originalMessage, forwardInfo, action, transformedContent, targetChannelId);
      }

      logger.error('Failed to schedule post:', error);
      throw error;
    }
  }

  /**
   * Get count of pending scheduled posts
   */
  async getPendingPostsCount(): Promise<number> {
    const targetChannelId = await getTargetChannelId();
    if (!targetChannelId) {
      return 0;
    }

    const now = new Date();
    return await ScheduledPost.countDocuments({
      status: 'pending',
      scheduledTime: { $gte: now },
      targetChannelId,
    });
  }

  /**
   * Get next N pending scheduled posts
   */
  async getNextPendingPosts(limit: number = 5) {
    const targetChannelId = await getTargetChannelId();
    if (!targetChannelId) {
      return [];
    }

    const now = new Date();
    return await ScheduledPost.find({
      status: 'pending',
      scheduledTime: { $gte: now },
      targetChannelId,
    })
      .sort({ scheduledTime: 1 })
      .limit(limit);
  }
}
