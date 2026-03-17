import { InlineKeyboard } from 'grammy';

export interface NicknameInfo {
  userId: number;
  nickname: string;
}

export function createNicknameSelectKeyboard(nicknames: NicknameInfo[]): InlineKeyboard {
  const rows: object[][] = [
    [{ text: 'No attribution', callback_data: 'select_nickname:none', style: 'primary' }],
  ];

  nicknames.forEach((nick) => {
    rows.push([{ text: nick.nickname, callback_data: `select_nickname:${nick.userId}` }]);
  });

  return { inline_keyboard: rows } as unknown as InlineKeyboard;
}
