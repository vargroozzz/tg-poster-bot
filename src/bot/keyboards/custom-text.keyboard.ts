import { InlineKeyboard } from 'grammy';

export function createCustomTextKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [[
      { text: 'Skip', callback_data: 'custom_text:skip', style: 'primary' },
      { text: '✍️ Add text', callback_data: 'custom_text:add' },
    ]],
  } as unknown as InlineKeyboard;
}
