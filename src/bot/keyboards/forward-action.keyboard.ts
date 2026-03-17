import { InlineKeyboard } from 'grammy';

export function createForwardActionKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: '⚡ Quick post', callback_data: 'action:quick', style: 'primary' }],
      [
        { text: '✨ Transform', callback_data: 'action:transform' },
        { text: '➡️ Forward', callback_data: 'action:forward' },
      ],
    ],
  } as unknown as InlineKeyboard;
}
