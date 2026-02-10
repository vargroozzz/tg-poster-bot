import { Api } from 'grammy';
import { Message } from 'grammy/types';
import { ScheduledPost } from '../database/models/scheduled-post.model.js';
import { getTargetChannelId } from '../database/models/bot-settings.model.js';
import type { ForwardInfo, MessageContent, TransformAction } from '../types/message.types.js';
import type { ScheduledPostInfo } from '../types/schedule.types.js';
import { findNextAvailableSlot, formatSlotTime } from '../utils/time-slots.js';
import { logger } from '../utils/logger.js';

export class SchedulerService {
  constructor(private api: Api) {}

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
    const unixTimestamp = Math.floor(scheduledTime.getTime() / 1000);

    logger.info(
      `Scheduling ${transformedContent.type} post for ${formatSlotTime(scheduledTime)} (${targetChannelId})`
    );

    try {
      // Schedule via Telegram API based on content type
      let telegramScheduledMessageId: number | undefined;

      if (transformedContent.type === 'photo' && transformedContent.fileId) {
        logger.info(`Calling sendPhoto with schedule_date: ${unixTimestamp}`);
        const result = (await this.api.raw.sendPhoto({
          chat_id: targetChannelId,
          photo: transformedContent.fileId,
          caption: transformedContent.text,
          parse_mode: 'HTML',
          schedule_date: unixTimestamp,
        } as any)) as any;
        telegramScheduledMessageId = result.message_id;
        logger.info(`Telegram returned message_id: ${telegramScheduledMessageId}`);
      } else if (transformedContent.type === 'video' && transformedContent.fileId) {
        const result = (await this.api.raw.sendVideo({
          chat_id: targetChannelId,
          video: transformedContent.fileId,
          caption: transformedContent.text,
          parse_mode: 'HTML',
          schedule_date: unixTimestamp,
        } as any)) as any;
        telegramScheduledMessageId = result.message_id;
      } else if (transformedContent.type === 'document' && transformedContent.fileId) {
        const result = (await this.api.raw.sendDocument({
          chat_id: targetChannelId,
          document: transformedContent.fileId,
          caption: transformedContent.text,
          parse_mode: 'HTML',
          schedule_date: unixTimestamp,
        } as any)) as any;
        telegramScheduledMessageId = result.message_id;
      } else if (transformedContent.type === 'animation' && transformedContent.fileId) {
        const result = (await this.api.raw.sendAnimation({
          chat_id: targetChannelId,
          animation: transformedContent.fileId,
          caption: transformedContent.text,
          parse_mode: 'HTML',
          schedule_date: unixTimestamp,
        } as any)) as any;
        telegramScheduledMessageId = result.message_id;
      } else if (transformedContent.type === 'text' && transformedContent.text) {
        const result = (await this.api.raw.sendMessage({
          chat_id: targetChannelId,
          text: transformedContent.text,
          parse_mode: 'HTML',
          schedule_date: unixTimestamp,
        } as any)) as any;
        telegramScheduledMessageId = result.message_id;
      } else {
        throw new Error(`Unsupported content type: ${transformedContent.type}`);
      }

      // Save to MongoDB for record-keeping
      const post = await ScheduledPost.create({
        scheduledTime,
        targetChannelId,
        telegramScheduledMessageId,
        originalForward: forwardInfo,
        content: transformedContent,
        action,
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
      scheduledTime: { $gte: now },
      targetChannelId,
    })
      .sort({ scheduledTime: 1 })
      .limit(limit);
  }
}
