import { Api } from 'grammy';
import type { IScheduledPost, EmbeddedReplyData } from '../../database/models/scheduled-post.model.js';
import { MediaSenderService, toReplyParameters } from '../sending/media-sender.service.js';
import { withSpoilers } from '../sending/spoilers.js';
import { logger } from '../../utils/logger.js';

// Telegram rejects a quote it can't find in the replied-to message (e.g. the parent was edited
// after the reply was queued). Post without the quote rather than failing the post.
const QUOTE_ERROR = /QUOTE/;

/**
 * Service for publishing posts to Telegram
 * Extracted from PostWorkerService to handle only publishing logic
 */
export class PostPublisherService {
  private mediaSender: MediaSenderService;

  constructor(private api: Api) {
    this.mediaSender = new MediaSenderService(api);
  }

  /**
   * Publish a post to Telegram based on its content type
   * Returns the Telegram message ID of the published message
   */
  async publish(post: IScheduledPost): Promise<number> {
    const hasQuote = !!(post.originalForward.replyQuote ?? post.originalForward.replyParameters?.quote);
    return this.withQuoteFallback(hasQuote, (quoted) => this.publishOnce(post, quoted));
  }

  private async withQuoteFallback(hasQuote: boolean, send: (quoted: boolean) => Promise<number>): Promise<number> {
    try {
      return await send(hasQuote);
    } catch (error) {
      if (!(hasQuote && error instanceof Error && QUOTE_ERROR.test(error.message))) throw error;
      logger.warn(`Reply quote rejected (${error.message}), posting without it`);
      return await send(false);
    }
  }

  private async publishOnce(post: IScheduledPost, quoted: boolean): Promise<number> {
    // For 'forward' action, use forwardMessage to preserve "Forwarded from" attribution
    if (post.action === 'forward') {
      return await this.copyMessage(post, quoted);
    }

    // For 'transform' action, thread reply_parameters from separated reply or forward origin
    const origin = post.originalForward.replyParameters;
    const replyParams =
      post.replyToMessageId && post.replyToChannelId
        ? {
            messageId: post.replyToMessageId,
            chatId: parseInt(post.replyToChannelId, 10),
            quote: quoted ? post.originalForward.replyQuote : undefined,
          }
        : origin && { chatId: origin.chatId, messageId: origin.messageId, quote: quoted ? origin.quote : undefined };

    return await this.mediaSender.sendMessage(
      post.targetChannelId,
      withSpoilers(post.content, post.spoilers),
      replyParams,
      post.textAbove
    );
  }

  /**
   * Publish an embedded (together) reply, using the parent's message_id as reply target.
   * For 'forward' action: uses copyMessage API so reply_parameters can be attached
   * (forwardMessage does not support reply_parameters).
   */
  async publishEmbeddedReply(
    reply: EmbeddedReplyData,
    parentMessageId: number,
    parentChannelId: string
  ): Promise<number> {
    return this.withQuoteFallback(!!reply.originalForward.replyQuote, (quoted) =>
      this.publishEmbeddedReplyOnce(reply, parentMessageId, parentChannelId, quoted)
    );
  }

  private async publishEmbeddedReplyOnce(
    reply: EmbeddedReplyData,
    parentMessageId: number,
    parentChannelId: string,
    quoted: boolean
  ): Promise<number> {
    const parentChatId = parseInt(parentChannelId, 10);
    const replyParams = {
      messageId: parentMessageId,
      chatId: parentChatId,
      quote: quoted ? reply.originalForward.replyQuote : undefined,
    };

    if (reply.action === 'forward') {
      const result = await this.api.copyMessage(
        reply.targetChannelId,
        reply.originalForward.chatId,
        reply.originalForward.messageId,
        { reply_parameters: toReplyParameters(replyParams) }
      );
      return result.message_id;
    }

    return await this.mediaSender.sendMessage(
      reply.targetChannelId,
      withSpoilers(reply.content, reply.spoilers),
      replyParams,
      reply.textAbove
    );
  }

  /**
   * Forward message using Telegram's forwardMessage(s) API
   * This preserves the "Forwarded from" attribution
   * For media groups, forwards all messages atomically to preserve the album
   */
  private async copyMessage(post: IScheduledPost, quoted: boolean): Promise<number> {
    if (!post.originalForward.chatId || !post.originalForward.messageId) {
      throw new Error('Missing chatId or messageId for forwardMessage');
    }

    // For reply chains or media groups, forward all messages atomically
    const replyChain = post.originalForward.replyChainMessageIds;
    const mediaGroup = post.originalForward.mediaGroupMessageIds;
    const bulkMessageIds =
      replyChain && replyChain.length > 1
        ? replyChain
        : mediaGroup && mediaGroup.length > 1
          ? mediaGroup
          : null;

    if (bulkMessageIds) {
      const result = await this.api.forwardMessages(
        post.targetChannelId,
        post.originalForward.chatId,
        bulkMessageIds
      );
      return result[0].message_id;
    }

    // If this is a separated reply, use copyMessage so reply_parameters can be passed.
    // forwardMessage does not support reply_parameters.
    if (post.replyToMessageId && post.replyToChannelId) {
      const result = await this.api.copyMessage(
        post.targetChannelId,
        post.originalForward.chatId,
        post.originalForward.messageId,
        {
          reply_parameters: toReplyParameters({
            messageId: post.replyToMessageId,
            chatId: parseInt(post.replyToChannelId, 10),
            quote: quoted ? post.originalForward.replyQuote : undefined,
          }),
        }
      );
      return result.message_id;
    }

    // Single message forward
    const result = await this.api.forwardMessage(
      post.targetChannelId,
      post.originalForward.chatId,
      post.originalForward.messageId
    );

    return result.message_id;
  }
}
