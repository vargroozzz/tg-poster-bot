import { Api } from 'grammy';
import { ScheduledPost, type IScheduledPost } from '../database/models/scheduled-post.model.js';
import { logger } from '../utils/logger.js';
import { formatSlotTime } from '../utils/time-slots.js';
import { PostPublisherService } from '../core/posting/post-publisher.service.js';

/**
 * Background worker service for processing scheduled posts
 * Coordinates publishing via PostPublisherService
 */
export class PostWorkerService {
  private intervalId: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private publisher: PostPublisherService;

  constructor(api: Api) {
    this.publisher = new PostPublisherService(api);
  }

  /**
   * Start the background worker that checks for posts to publish
   */
  start() {
    if (this.intervalId) {
      logger.warn('Post worker already running');
      return;
    }

    logger.info('Starting post worker - checking every 30 seconds');

    // Run immediately
    this.processScheduledPosts().catch((error) => {
      logger.error('Error in initial post processing:', error);
    });

    // Then run every 30 seconds
    this.intervalId = setInterval(() => {
      this.processScheduledPosts().catch((error) => {
        logger.error('Error in post worker:', error);
      });
    }, 30000); // 30 seconds
  }

  /**
   * Stop the background worker
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Post worker stopped');
    }
  }

  /**
   * Process posts immediately (for manual trigger or cron job)
   */
  async processNow() {
    return this.processScheduledPosts();
  }

  /**
   * Process all pending posts whose time has arrived
   */
  private async processScheduledPosts() {
    if (this.isProcessing) {
      logger.debug('Previous processing still running, skipping this cycle');
      return;
    }

    this.isProcessing = true;

    try {
      const now = new Date();

      // Find all pending posts whose scheduled time has arrived
      const posts = await ScheduledPost.find({
        status: 'pending',
        scheduledTime: { $lte: now },
      })
        .sort({ scheduledTime: 1 })
        .limit(10); // Process max 10 at a time

      if (posts.length > 0) {
        logger.info(`Found ${posts.length} post(s) ready to publish`);

        for (const post of posts) {
          await this.publishPost(post);
        }
      }
    } catch (error) {
      logger.error('Error processing scheduled posts:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Publish a single post to Telegram
   */
  private async publishPost(post: IScheduledPost) {
    try {
      logger.info(
        `Publishing ${post.content.type} post to ${post.targetChannelId} (scheduled for ${formatSlotTime(post.scheduledTime)})`
      );

      // Delegate publishing to the publisher service
      const messageId = await this.publisher.publish(post);

      // Mark as posted
      post.status = 'posted';
      post.postedAt = new Date();
      post.telegramScheduledMessageId = messageId;
      await post.save();

      logger.info(`Successfully published post ${post._id} with message_id ${messageId}`);
    } catch (error) {
      logger.error(`Failed to publish post ${post._id}:`, error);

      // Mark as failed
      post.status = 'failed';
      post.error = error instanceof Error ? error.message : String(error);
      await post.save();
    }
  }
}
