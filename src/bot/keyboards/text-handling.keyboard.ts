import { InlineKeyboard } from 'grammy';

export function createTextHandlingKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Remove text', callback_data: 'text:remove', style: 'primary' },
        { text: 'Keep text', callback_data: 'text:keep' },
      ],
      [{ text: 'Wrap in quote', callback_data: 'text:quote' }],
    ],
  } as unknown as InlineKeyboard;
}
