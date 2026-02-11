import { listUserNicknames } from '../../database/models/user-nickname.model.js';
import { createNicknameSelectKeyboard } from '../../bot/keyboards/nickname-select.keyboard.js';

/**
 * Nickname option for keyboard
 */
export interface NicknameOption {
  userId: number;
  nickname: string;
}

/**
 * Nickname helper utilities
 * Consolidates duplicate nickname fetching and keyboard generation logic
 */
export class NicknameHelper {
  /**
   * Get nickname options from database
   * Returns array of userId/nickname pairs
   */
  static async getNicknameOptions(): Promise<NicknameOption[]> {
    const nicknames = await listUserNicknames();
    return nicknames.map((n) => ({
      userId: n.userId,
      nickname: n.nickname,
    }));
  }

  /**
   * Get nickname selection keyboard
   * Fetches nicknames and creates keyboard in one call
   */
  static async getNicknameKeyboard() {
    const options = await this.getNicknameOptions();
    return createNicknameSelectKeyboard(options);
  }

  /**
   * Find nickname by user ID
   * Returns nickname string or null if not found
   */
  static async findNicknameByUserId(userId: number): Promise<string | null> {
    const nicknames = await listUserNicknames();
    const found = nicknames.find((n) => n.userId === userId);
    return found?.nickname ?? null;
  }

  /**
   * Parse nickname selection from callback data
   * If selection is "none", returns null (no attribution)
   * Otherwise, looks up the nickname by userId
   */
  static async parseNicknameSelection(selection: string): Promise<string | null> {
    if (selection === 'none') {
      return null;
    }

    const userId = parseInt(selection, 10);
    if (isNaN(userId)) {
      return null;
    }

    return await this.findNicknameByUserId(userId);
  }
}
