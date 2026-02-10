import type { ForwardInfo, TransformAction, TextHandling } from '../types/message.types.js';
import { channelListService } from './channel-list.service.js';
import { logger } from '../utils/logger.js';

export class TransformerService {
  /**
   * Transform message text with attribution based on forward info and action
   */
  async transformMessage(
    originalText: string,
    forwardInfo: ForwardInfo,
    action: TransformAction,
    textHandling: TextHandling = 'keep'
  ): Promise<string> {
    // Handle text modifications first
    let processedText = originalText;

    if (textHandling === 'remove') {
      processedText = '';
    } else if (textHandling === 'quote' && originalText) {
      processedText = `<blockquote>${originalText}</blockquote>`;
    }
    // If action is 'forward', return original text
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

      // From channel, not red-listed - add channel attribution only if messageLink exists
      if (!isRed && forwardInfo.messageLink) {
        const channelReference =
          forwardInfo.fromChannelUsername ?? forwardInfo.fromChannelTitle ?? 'Unnamed Channel';
        const attribution = `\n\nvia <a href="${forwardInfo.messageLink}">${channelReference}</a>`;
        return processedText + attribution;
      }

      // From channel, red-listed - check if forwarded by a user
      if (isRed && forwardInfo.fromUsername) {
        const attribution = `\n\nvia ${forwardInfo.fromUsername}`;
        return processedText + attribution;
      }

      // From channel, red-listed, direct forward - no attribution
      return processedText;
    }

    // From user (not via channel)
    if (forwardInfo.fromUsername) {
      const attribution = `\n\nvia ${forwardInfo.fromUsername}`;
      return processedText + attribution;
    }

    // From hidden user or no username
    return processedText;
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
