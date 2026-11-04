import { Api } from 'grammy';
import { ScheduledPost, FAILED, embeddedRepliesOf, type IScheduledPost } from '../database/models/scheduled-post.model.js';
import { ScheduledPostRepository, PARENT_FAILED } from '../database/repositories/scheduled-post.repository.js';
import { config } from '../config/index.js';
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
  private repository = new ScheduledPostRepository();

  constructor(private api: Api) {
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
      }

      await Promise.all(posts.map(async (post) => await this.publishPost(post)));
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
    logger.info(
      `Publishing ${post.content.type} post to ${post.targetChannelId} (scheduled for ${formatSlotTime(post.scheduledTime)})`
    );

    // Only a failed send fails the post and its replies; what follows a sent post must not.
    const sent = await this.publisher.publish(post).catch(async (error: unknown) => {
      logger.error(`Failed to publish post ${post._id}:`, error);
      const message = error instanceof Error ? error.message : String(error);
      await post.updateOne({ status: FAILED, error: message });
      await this.failReplies(post, message);
      return undefined;
    });
    if (sent === undefined) return;
    const messageId = sent;

    try {
      await post.updateOne({ status: 'posted', postedAt: new Date(), telegramScheduledMessageId: messageId });

      // Publish the together (embedded) reply chain in the same cycle
      const embedded = embeddedRepliesOf(post);
      if (embedded.length > 0) {
        const errors = await this.publisher.publishEmbeddedChain(embedded, messageId, post.targetChannelId);
        if (errors.length > 0) {
          logger.error(`Failed to publish embedded replies for post ${post._id}: ${errors.join('; ')}`);
          await post.updateOne({ embeddedReplyError: errors.join('; ') });
        } else {
          logger.info(`Published ${embedded.length} embedded repl${embedded.length === 1 ? 'y' : 'ies'} for post ${post._id}`);
        }
      }

      // Unblock separated reply posts that were waiting for this parent
      try {
        await this.repository.unblockSeparatedReplies(post._id.toString(), messageId, post.targetChannelId);
      } catch (error) {
        logger.error(`Failed to unblock separated replies for post ${post._id}:`, error);
      }

      logger.info(`Successfully published post ${post._id} with message_id ${messageId}`);
    } catch (error) {
      logger.error(`Post ${post._id} was published as message ${messageId}, but recording it failed:`, error);
    }
  }

  // Replies waiting on a failed post can never be sent; fail them too and tell the owner.
  private async failReplies(post: IScheduledPost, error: string) {
    try {
      const failed = await this.repository.failWaitingReplies(post._id.toString(), PARENT_FAILED);
      await this.api.sendMessage(
        config.authorizedUserId,
        `⚠️ A post scheduled for ${formatSlotTime(post.scheduledTime)} failed to publish: ${error}` +
          (failed > 0 ? `\n${failed} ${failed === 1 ? 'reply' : 'replies'} waiting on it failed too.` : '')
      );
    } catch (notifyError) {
      logger.error(`Failed to settle replies of failed post ${post._id}:`, notifyError);
    }
  }
}
