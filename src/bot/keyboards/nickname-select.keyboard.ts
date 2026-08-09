import type { InlineKeyboardMarkup } from 'grammy/types';
import { POST_FLOW, type FlowCallbacks } from './flow-callbacks.js';

export const NICKNAME_NONE_KEY = 'none';

export interface NicknameInfo {
  userId: number;
  nickname: string;
}

export function createNicknameSelectKeyboard(
  nicknames: NicknameInfo[],
  cb: FlowCallbacks = POST_FLOW
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...nicknames.map((nick) => [
        { text: nick.nickname, callback_data: cb('nickname', String(nick.userId)) },
      ]),
      [{ text: 'No attribution', callback_data: cb('nickname', NICKNAME_NONE_KEY), style: 'primary' as const }],
    ],
  };
}
