import type { InlineKeyboardMarkup } from 'grammy/types';

export function createForwardActionKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '⚡ Quick post', callback_data: 'action:quick', style: 'primary' }],
      [
        { text: '✨ Transform', callback_data: 'action:transform' },
        { text: '➡️ Forward', callback_data: 'action:forward' },
      ],
    ],
  };
}
