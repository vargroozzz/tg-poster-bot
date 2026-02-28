import { Context } from 'grammy';
import type { Message } from 'grammy/types';
import { ErrorMessages } from '../constants/error-messages.js';
import type { PostSelections } from '../../types/message.types.js';

/**
 * Interface for pending forward data structure
 * Extracted from forward.handler.ts
 */
export interface PendingForward extends PostSelections {
  message: Message;
  timestamp: number;
}

/**
 * Helper class to find pending forwards in the Map
 * Eliminates 9 duplicate loop implementations across handlers
 */
export class PendingForwardHelper {
  /**
   * Find a pending forward by message ID
   * Returns [key, value] tuple or null if not found
   */
  static findByMessageId(
    messageId: number,
    pendingForwards: Map<string, PendingForward>
  ): [string, PendingForward] | null {
    for (const [key, value] of pendingForwards.entries()) {
      if (value.message.message_id === messageId) {
        return [key, value];
      }
    }
    return null;
  }

  /**
   * Find a pending forward by message ID, show error and return null if not found
   * Combines lookup + error handling for common use case
   */
  static async getOrExpire(
    ctx: Context,
    messageId: number,
    pendingForwards: Map<string, PendingForward>
  ): Promise<[string, PendingForward] | null> {
    const result = this.findByMessageId(messageId, pendingForwards);
    if (!result) {
      await ErrorMessages.sessionExpired(ctx);
      return null;
    }
    return result;
  }

  /**
   * Update a pending forward by message ID
   * Returns the key if found and updated, null otherwise
   */
  static updateByMessageId(
    messageId: number,
    pendingForwards: Map<string, PendingForward>,
    updates: Partial<PendingForward>
  ): string | null {
    const found = this.findByMessageId(messageId, pendingForwards);
    if (!found) {
      return null;
    }

    const [key, value] = found;
    Object.assign(value, updates);
    return key;
  }

  /**
   * Update a pending forward and show error if not found
   */
  static async updateOrExpire(
    ctx: Context,
    messageId: number,
    pendingForwards: Map<string, PendingForward>,
    updates: Partial<PendingForward>
  ): Promise<string | null> {
    const key = this.updateByMessageId(messageId, pendingForwards, updates);
    if (!key) {
      await ErrorMessages.sessionExpired(ctx);
      return null;
    }
    return key;
  }
}
