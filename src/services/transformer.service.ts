import type { ForwardInfo, TransformAction } from '../types/message.types.js';
import { channelListService } from './channel-list.service.js';
import { logger } from '../utils/logger.js';

export class TransformerService {
  /**
   * Transform message text with attribution based on forward info and action
   */
  async transformMessage(
    originalText: string,
    forwardInfo: ForwardInfo,
    action: TransformAction
  ): Promise<string> {
    // If action is 'forward', return original text
    if (action === 'forward') {
      return originalText;
    }

    // If from a channel and green-listed, return original (should not reach here, but safety check)
    if (forwardInfo.fromChannelId) {
      const channelId = String(forwardInfo.fromChannelId);
      const isGreen = await channelListService.isGreenListed(channelId);

      if (isGreen) {
        logger.debug(`Channel ${channelId} is green-listed, returning original text`);
        return originalText;
      }

      const isRed = await channelListService.isRedListed(channelId);

      // From channel, not red-listed - add channel attribution
      if (!isRed) {
        if (forwardInfo.messageLink && forwardInfo.fromChannelTitle) {
          const attribution = `\n\nvia [${forwardInfo.fromChannelTitle}](${forwardInfo.messageLink})`;
          return originalText + attribution;
        } else if (forwardInfo.fromChannelTitle) {
          const attribution = `\n\nvia ${forwardInfo.fromChannelTitle}`;
          return originalText + attribution;
        }
      }

      // From channel, red-listed - check if forwarded by a user
      if (isRed && forwardInfo.fromUsername) {
        const attribution = `\n\nvia @${forwardInfo.fromUsername}`;
        return originalText + attribution;
      }

      // From channel, red-listed, direct forward - no attribution
      return originalText;
    }

    // From user (not via channel)
    if (forwardInfo.fromUsername) {
      const attribution = `\n\nvia @${forwardInfo.fromUsername}`;
      return originalText + attribution;
    }

    // From hidden user or no username
    return originalText;
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
