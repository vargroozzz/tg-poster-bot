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
    originalMessage?: Message;
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

    const nextSlot = await findNextAvailableSlot(targetChannelId);

    const originalText = content.text ?? '';
    const transformedText = await transformerService.transformMessage(
      originalText,
      forwardInfo,
      'transform',
      textHandling,
      selectedNickname,
      customText
    );

    const transformedContent = {
      ...content,
      text: transformedText,
    };

    const scheduledPost = await this.repository.create({
      scheduledTime: nextSlot,
      targetChannelId,
      status: 'pending',
      action: 'transform',
      originalForward: forwardInfo,
      content: transformedContent,
      rawContent: content,
      textHandling,
      selectedNickname: selectedNickname ?? null,
      customText,
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
    originalMessage?: Message;
    forwardInfo: ForwardInfo;
    content: MessageContent;
  }): Promise<{ scheduledTime: Date; postId: string }> {
    const { targetChannelId, forwardInfo, content } = params;

    const nextSlot = await findNextAvailableSlot(targetChannelId);

    const processedText = await transformerService.transformMessage(
      content.text ?? '',
      forwardInfo,
      'forward',
      'keep',
      undefined,
      undefined
    );

    const processedContent = {
      ...content,
      text: processedText,
    };

    const scheduledPost = await this.repository.create({
      scheduledTime: nextSlot,
      targetChannelId,
      status: 'pending',
      action: 'forward',
      originalForward: forwardInfo,
      content: processedContent,
      rawContent: content,
      textHandling: 'keep',
      selectedNickname: null,
      createdAt: new Date(),
    });

    return {
      scheduledTime: nextSlot,
      postId: scheduledPost._id.toString(),
    };
  }
}
