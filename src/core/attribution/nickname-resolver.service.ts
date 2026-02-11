import { getUserNickname } from '../../database/models/user-nickname.model.js';

/**
 * Service for resolving user nicknames
 * Handles nickname lookup and attribution text generation
 */
export class NicknameResolverService {
  /**
   * Resolve nickname for a user ID
   * Returns the custom nickname if set, otherwise null
   */
  async resolveNickname(userId: number): Promise<string | null> {
    return await getUserNickname(userId);
  }

  /**
   * Get user attribution text
   * Returns the custom nickname if available, otherwise null
   */
  async getUserAttribution(userId?: number): Promise<string | null> {
    if (!userId) {
      return null;
    }

    return await this.resolveNickname(userId);
  }
}
