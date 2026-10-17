import type { Message } from 'grammy/types';
import type { ForwardInfo, MessageContent, TextHandling } from '../../types/message.types.js';
import { ScheduledPostRepository } from '../../database/repositories/scheduled-post.repository.js';
import { findNextAvailableSlot } from '../../utils/time-slots.js';
import { transformerService } from '../../services/transformer.service.js';
import { getUserNickname } from '../../database/models/user-nickname.model.js';

/** A message already in a channel that the post is published as a reply to. */
export interface ReplyTarget {
  replyToChannelId: string;
  replyToMessageId: number;
}

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
    selectedUserId?: number | null;
    customText?: string;
    textAbove?: boolean;
    spoilers?: boolean[];
    replyTo?: ReplyTarget;
  }): Promise<{ scheduledTime: Date; postId: string }> {
    const {
      targetChannelId,
      forwardInfo,
      content,
      textHandling,
      selectedUserId,
      customText,
      textAbove,
      spoilers,
      replyTo,
    } = params;

    const selectedNickname = selectedUserId ? await getUserNickname(selectedUserId) : null;

    const nextSlot = await findNextAvailableSlot(targetChannelId);

    const transformedContent = await transformerService.transformContent(
      content,
      forwardInfo,
      'transform',
      textHandling,
      selectedNickname,
      customText
    );

    const scheduledPost = await this.repository.create({
      scheduledTime: nextSlot,
      targetChannelId,
      status: 'pending',
      action: 'transform',
      originalForward: forwardInfo,
      content: transformedContent,
      rawContent: content,
      textHandling,
      selectedUserId: selectedUserId ?? null,
      customText,
      textAbove,
      spoilers,
      ...replyTo,
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
    replyTo?: ReplyTarget;
  }): Promise<{ scheduledTime: Date; postId: string }> {
    const { targetChannelId, forwardInfo, content, replyTo } = params;

    const nextSlot = await findNextAvailableSlot(targetChannelId);

    const processedContent = {
      ...content,
      text: content.text ?? '',
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
      selectedUserId: null,
      ...replyTo,
      createdAt: new Date(),
    });

    return {
      scheduledTime: nextSlot,
      postId: scheduledPost._id.toString(),
    };
  }
}
