import type { InlineKeyboardMarkup } from 'grammy/types';

export function createTextHandlingKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'Remove text', callback_data: 'text:remove', style: 'primary' },
        { text: 'Keep text', callback_data: 'text:keep' },
      ],
      [{ text: 'Wrap in quote', callback_data: 'text:quote' }],
    ],
  };
}
