import { Context } from 'grammy';
import { parseForwardInfo } from '../../utils/message-parser.js';

/**
 * Validation helper utilities
 * Extracts duplicate validation logic from command handlers
 */
export class ValidationHelper {
  /**
   * Check if a channel ID has the correct format
   */
  static isValidChannelId(channelId: string): boolean {
    return /^-\d+$/.test(channelId);
  }

  /**
   * Validate channel ID and show error if invalid
   * Returns validated channel ID or null if invalid
   */
  static async validateChannelId(
    ctx: Context,
    channelId?: string
  ): Promise<string | null> {
    if (!channelId || !this.isValidChannelId(channelId)) {
      await ctx.reply(
        '❌ Invalid channel ID format. It should start with - and be numeric.'
      );
      return null;
    }
    return channelId;
  }

  /**
   * Extract channel ID from a reply-to-message or from provided ID
   * Used in commands like /greenlist, /redlist that can extract from forwarded messages
   */
  static async extractChannelIdFromReply(
    ctx: Context,
    providedId?: string
  ): Promise<string | null> {
    // If ID provided explicitly, validate and return
    if (providedId) {
      return this.validateChannelId(ctx, providedId);
    }

    // Try to extract from reply-to-message
    const replyToMessage = ctx.message?.reply_to_message;
    if (!replyToMessage) {
      await ctx.reply(
        '❌ Please provide a channel ID or reply to a forwarded message from the channel.'
      );
      return null;
    }

    // Parse forward info to get channel ID
    const forwardInfo = parseForwardInfo(replyToMessage);
    if (forwardInfo?.fromChannelId) {
      return String(forwardInfo.fromChannelId);
    }

    await ctx.reply('❌ The replied message must be forwarded from a channel.');
    return null;
  }

  /**
   * Extract user ID from command text
   * Format: /command <userId> [other params]
   */
  static extractUserId(commandText: string): number | null {
    const parts = commandText.trim().split(/\s+/);
    if (parts.length < 2) {
      return null;
    }

    const userId = parseInt(parts[1], 10);
    return isNaN(userId) ? null : userId;
  }

  /**
   * Extract channel ID from command text
   * Format: /command <channelId> [other params]
   */
  static extractChannelId(commandText: string): string | null {
    const parts = commandText.trim().split(/\s+/);
    if (parts.length < 2) {
      return null;
    }

    const channelId = parts[1];
    return this.isValidChannelId(channelId) ? channelId : null;
  }
}
