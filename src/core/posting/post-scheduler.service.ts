import type { Message } from 'grammy/types';
import type { ForwardInfo, MessageContent, TextHandling } from '../../types/message.types.js';
import { ScheduledPostRepository } from '../../database/repositories/scheduled-post.repository.js';
import { findNextAvailableSlot } from '../../utils/time-slots.js';
import { transformerService } from '../../services/transformer.service.js';

/**
 * Service for scheduling posts
 * Consolidates duplicate scheduling logic from handlers
 */
export class PostSchedulerService {
  private repository: ScheduledPostRepository;

  constructor() {
    this.repository = new ScheduledPostRepository();
  }

  /**
   * Schedule a transformed post
   * Unified implementation that replaces duplicate functions in handlers
   */
  async scheduleTransformPost(params: {
    targetChannelId: string;
    originalMessage: Message;
    forwardInfo: ForwardInfo;
    content: MessageContent;
    textHandling: TextHandling;
    selectedNickname?: string | null;
    customText?: string;
  }): Promise<{ scheduledTime: Date; postId: string }> {
    const {
      targetChannelId,
      forwardInfo,
      content,
      textHandling,
      selectedNickname,
      customText,
    } = params;

    // Find next available slot
    const nextSlot = await findNextAvailableSlot(targetChannelId);

    // Transform the message text
    const originalText = content.text ?? '';
    const transformedText = await transformerService.transformMessage(
      originalText,
      forwardInfo,
      'transform',
      textHandling,
      selectedNickname,
      customText
    );

    // Create transformed content
    const transformedContent = {
      ...content,
      text: transformedText,
    };

    // Save to database
    const scheduledPost = await this.repository.create({
      scheduledTime: nextSlot,
      targetChannelId,
      status: 'pending',
      action: 'transform',
      originalForward: forwardInfo,
      content: transformedContent,
      createdAt: new Date(),
    });

    return {
      scheduledTime: nextSlot,
      postId: scheduledPost._id.toString(),
    };
  }

  /**
   * Schedule a forward post (no transformation)
   */
  async scheduleForwardPost(params: {
    targetChannelId: string;
    originalMessage: Message;
    forwardInfo: ForwardInfo;
    content: MessageContent;
  }): Promise<{ scheduledTime: Date; postId: string }> {
    const { targetChannelId, forwardInfo, content } = params;

    // Find next available slot
    const nextSlot = await findNextAvailableSlot(targetChannelId);

    // Process text through transformer (for consistency, though forward action doesn't transform)
    const processedText = await transformerService.transformMessage(
      content.text ?? '',
      forwardInfo,
      'forward',
      'keep',
      undefined,
      undefined
    );

    // Create content with processed text
    const processedContent = {
      ...content,
      text: processedText,
    };

    // Save to database
    const scheduledPost = await this.repository.create({
      scheduledTime: nextSlot,
      targetChannelId,
      status: 'pending',
      action: 'forward',
      originalForward: forwardInfo,
      content: processedContent,
      createdAt: new Date(),
    });

    return {
      scheduledTime: nextSlot,
      postId: scheduledPost._id.toString(),
    };
  }
}
