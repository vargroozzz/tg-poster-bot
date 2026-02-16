import type { ForwardInfo } from '../../types/message.types.js';
import { NicknameResolverService } from './nickname-resolver.service.js';
import { ChannelListRepository } from '../../database/repositories/channel-list.repository.js';
import { logger } from '../../utils/logger.js';

/**
 * Service for building attribution strings
 * Handles complex logic for channel and user attribution based on rules
 */
export class AttributionService {
  constructor(
    private nicknameResolver: NicknameResolverService,
    private channelListRepo: ChannelListRepository
  ) {}

  /**
   * Build attribution string based on forward info and user selection
   * @param forwardInfo - Information about the forwarded message
   * @param manualNickname - Manually selected nickname (null = no attribution, undefined = auto lookup)
   * @returns Attribution string to append to message, or null if no attribution
   */
  async buildAttribution(
    forwardInfo: ForwardInfo,
    manualNickname?: string | null
  ): Promise<string | null> {
    // From a channel
    if (forwardInfo.fromChannelId) {
      return await this.buildChannelAttribution(forwardInfo, manualNickname);
    }

    // From a user (not via channel)
    if (forwardInfo.fromUserId) {
      return await this.buildUserAttribution(forwardInfo.fromUserId, manualNickname);
    }

    // For original content (no forward info) with manually selected nickname
    if (manualNickname !== undefined && manualNickname !== null) {
      return `\n\nvia ${manualNickname}`;
    }

    // No attribution available
    return null;
  }

  /**
   * Build attribution for channel-forwarded messages
   */
  private async buildChannelAttribution(
    forwardInfo: ForwardInfo,
    manualNickname?: string | null
  ): Promise<string | null> {
    const channelId = String(forwardInfo.fromChannelId);

    // Check if green-listed (should not reach here, but safety check)
    const isGreen = await this.channelListRepo.isGreenListed(channelId);
    if (isGreen) {
      logger.debug(`Channel ${channelId} is green-listed, no attribution needed`);
      return null;
    }

    // Check if red-listed
    const isRed = await this.channelListRepo.isRedListed(channelId);

    // Determine the nickname to use
    const userNickname = await this.resolveUserNickname(
      forwardInfo.fromUserId,
      manualNickname
    );

    // Red-listed channel: OMIT channel reference
    if (isRed) {
      if (userNickname) {
        return `\n\nvia ${userNickname}`;
      }
      return null; // No attribution for red-listed without nickname
    }

    // Not red-listed: Include channel reference if available
    if (forwardInfo.messageLink) {
      const channelReference =
        forwardInfo.fromChannelUsername ??
        forwardInfo.fromChannelTitle ??
        'Unnamed Channel';
      const channelPart = `<a href="${forwardInfo.messageLink}">${channelReference}</a>`;

      if (userNickname) {
        return `\n\nfrom ${userNickname} via ${channelPart}`;
      }

      return `\n\nvia ${channelPart}`;
    }

    // No message link - no attribution
    return null;
  }

  /**
   * Build attribution for user-forwarded messages (not via channel)
   */
  private async buildUserAttribution(
    userId: number,
    manualNickname?: string | null
  ): Promise<string | null> {
    const userNickname = await this.resolveUserNickname(userId, manualNickname);

    if (userNickname) {
      return `\n\nvia ${userNickname}`;
    }

    return null;
  }

  /**
   * Resolve which nickname to use based on manual selection or automatic lookup
   */
  private async resolveUserNickname(
    userId?: number,
    manualNickname?: string | null
  ): Promise<string | null> {
    // Manual nickname was explicitly provided
    if (manualNickname !== undefined) {
      return manualNickname; // null = no attribution, string = use this nickname
    }

    // No manual selection, try automatic lookup
    if (userId) {
      return await this.nicknameResolver.getUserAttribution(userId);
    }

    return null;
  }
}
