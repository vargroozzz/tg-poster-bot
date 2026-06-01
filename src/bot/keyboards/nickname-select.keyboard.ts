import type { InlineKeyboardMarkup } from 'grammy/types';

export const NICKNAME_NONE_KEY = 'none';

export interface NicknameInfo {
  userId: number;
  nickname: string;
}

export function createNicknameSelectKeyboard(nicknames: NicknameInfo[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...nicknames.map((nick) => [{ text: nick.nickname, callback_data: `select_nickname:${nick.userId}` }]),
      [{ text: 'No attribution', callback_data: `select_nickname:${NICKNAME_NONE_KEY}`, style: 'primary' as const }],
    ],
  };
}
