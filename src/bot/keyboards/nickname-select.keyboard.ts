import { InlineKeyboard } from 'grammy';

export interface NicknameInfo {
  userId: number;
  nickname: string;
}

export function createNicknameSelectKeyboard(nicknames: NicknameInfo[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Add "No attribution" option first
  keyboard.text('No attribution', 'select_nickname:none');

  if (nicknames.length > 0) {
    keyboard.row();

    nicknames.forEach((nick, index) => {
      keyboard.text(nick.nickname, `select_nickname:${nick.userId}`);

      // Add row break after each nickname for better readability
      if (index < nicknames.length - 1) {
        keyboard.row();
      }
    });
  }

  return keyboard;
}
