import { Api } from 'grammy';
import { ScheduledPost } from '../database/models/scheduled-post.model.js';
import { logger } from '../utils/logger.js';
import { formatSlotTime } from '../utils/time-slots.js';

export class PostWorkerService {
  private intervalId: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(private api: Api) {}

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
  private async publishPost(post: any) {
    try {
      logger.info(
        `Publishing ${post.content.type} post to ${post.targetChannelId} (scheduled for ${formatSlotTime(post.scheduledTime)})`
      );

      let result: any;

      // Post based on content type
      if (post.content.type === 'media_group' && post.content.mediaGroup) {
        // Build media array for sendMediaGroup
        const media = post.content.mediaGroup.map((item: any, index: number) => {
          const baseMedia = {
            media: item.fileId,
            // Only first item gets caption
            caption: index === 0 ? post.content.text : undefined,
            parse_mode: index === 0 ? ('HTML' as const) : undefined,
          };

          if (item.type === 'photo') {
            return { type: 'photo' as const, ...baseMedia };
          } else {
            return { type: 'video' as const, ...baseMedia };
          }
        });

        result = await this.api.sendMediaGroup(post.targetChannelId, media);
      } else if (post.content.type === 'photo' && post.content.fileId) {
        result = await this.api.sendPhoto(post.targetChannelId, post.content.fileId, {
          caption: post.content.text,
          parse_mode: 'HTML',
        });
      } else if (post.content.type === 'video' && post.content.fileId) {
        result = await this.api.sendVideo(post.targetChannelId, post.content.fileId, {
          caption: post.content.text,
          parse_mode: 'HTML',
        });
      } else if (post.content.type === 'document' && post.content.fileId) {
        result = await this.api.sendDocument(post.targetChannelId, post.content.fileId, {
          caption: post.content.text,
          parse_mode: 'HTML',
        });
      } else if (post.content.type === 'animation' && post.content.fileId) {
        result = await this.api.sendAnimation(post.targetChannelId, post.content.fileId, {
          caption: post.content.text,
          parse_mode: 'HTML',
        });
      } else if (post.content.type === 'text' && post.content.text) {
        result = await this.api.sendMessage(post.targetChannelId, post.content.text, {
          parse_mode: 'HTML',
        });
      } else {
        throw new Error(`Unsupported content type: ${post.content.type}`);
      }

      // Mark as posted
      post.status = 'posted';
      post.postedAt = new Date();
      // For media groups, result is an array, store first message ID
      post.telegramScheduledMessageId = Array.isArray(result) ? result[0].message_id : result.message_id;
      await post.save();

      const messageId = Array.isArray(result) ? `${result.length} messages` : `message_id ${result.message_id}`;
      logger.info(
        `Successfully published post ${post._id} with ${messageId}`
      );
    } catch (error) {
      logger.error(`Failed to publish post ${post._id}:`, error);

      // Mark as failed
      post.status = 'failed';
      post.error = error instanceof Error ? error.message : String(error);
      await post.save();
    }
  }
}
