import type { ForwardInfo, TransformAction, TextHandling } from '../types/message.types.js';
import { channelListService } from './channel-list.service.js';
import { getUserNickname } from '../database/models/user-nickname.model.js';
import { logger } from '../utils/logger.js';

export class TransformerService {
  /**
   * Transform message text with attribution based on forward info and action
   * @param manualNickname - Manually selected nickname (overrides automatic lookup). null = no attribution, undefined = use automatic lookup
   * @param customText - Optional custom text to prepend to the message
   */
  async transformMessage(
    originalText: string,
    forwardInfo: ForwardInfo,
    action: TransformAction,
    textHandling: TextHandling = 'keep',
    manualNickname?: string | null,
    customText?: string
  ): Promise<string> {
    // Handle text modifications first
    let processedText = originalText;

    if (textHandling === 'remove') {
      processedText = '';
    } else if (textHandling === 'quote' && originalText) {
      processedText = `<blockquote>${originalText}</blockquote>`;
    }

    // Prepend custom text if provided
    if (customText) {
      processedText = customText + (processedText ? '\n\n' + processedText : '');
    }

    // If action is 'forward', return processed text with custom text
    if (action === 'forward') {
      return processedText;
    }

    // If from a channel and green-listed, return processed (should not reach here, but safety check)
    if (forwardInfo.fromChannelId) {
      const channelId = String(forwardInfo.fromChannelId);
      const isGreen = await channelListService.isGreenListed(channelId);

      if (isGreen) {
        logger.debug(`Channel ${channelId} is green-listed, returning processed text`);
        return processedText;
      }

      const isRed = await channelListService.isRedListed(channelId);

      // Determine the nickname to use
      let userNickname: string | null = null;

      if (manualNickname !== undefined) {
        // Manual nickname was explicitly provided (null = no attribution, string = use this nickname)
        userNickname = manualNickname;
      } else if (forwardInfo.fromUserId) {
        // No manual selection, try automatic lookup
        userNickname = await this.getUserAttribution(forwardInfo.fromUserId);
      }

      // From channel, not red-listed - add channel attribution
      if (!isRed && forwardInfo.messageLink) {
        const channelReference =
          forwardInfo.fromChannelUsername ?? forwardInfo.fromChannelTitle ?? 'Unnamed Channel';
        const channelPart = `<a href="${forwardInfo.messageLink}">${channelReference}</a>`;

        // If nickname selected/found, show "from [nickname] via [channel]"
        if (userNickname) {
          const attribution = `\n\nfrom ${userNickname} via ${channelPart}`;
          return processedText + attribution;
        }

        // No nickname - just show channel
        const attribution = `\n\nvia ${channelPart}`;
        return processedText + attribution;
      }

      // From channel, red-listed
      if (isRed) {
        // If nickname selected/found, show "from [nickname] via [channel name]"
        if (userNickname) {
          const channelReference =
            forwardInfo.fromChannelUsername ?? forwardInfo.fromChannelTitle ?? 'Unnamed Channel';
          const attribution = `\n\nfrom ${userNickname} via ${channelReference}`;
          return processedText + attribution;
        }

        // No nickname - no attribution for red-listed
        return processedText;
      }

      // No messageLink and not red-listed - no attribution
      return processedText;
    }

    // From user (not via channel) - only add attribution if custom nickname is set
    if (forwardInfo.fromUserId) {
      const userAttribution = await this.getUserAttribution(forwardInfo.fromUserId);
      if (userAttribution) {
        const attribution = `\n\nvia ${userAttribution}`;
        return processedText + attribution;
      }
    }

    // From hidden user or no username
    return processedText;
  }

  /**
   * Get user attribution text (custom nickname only, or null)
   */
  private async getUserAttribution(userId?: number): Promise<string | null> {
    if (!userId) {
      return null;
    }

    // Only return attribution if custom nickname is set
    return await getUserNickname(userId);
  }

  /**
   * Check if a channel forward should be auto-forwarded (green-listed)
   */
  async shouldAutoForward(forwardInfo: ForwardInfo): Promise<boolean> {
    if (!forwardInfo.fromChannelId) {
      return false;
    }

    const channelId = String(forwardInfo.fromChannelId);
    return await channelListService.isGreenListed(channelId);
  }
}

export const transformerService = new TransformerService();
