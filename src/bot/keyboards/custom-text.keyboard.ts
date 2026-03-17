import { InlineKeyboard } from 'grammy';

export function createCustomTextKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Skip', 'custom_text:skip')
    .text('✍️ Add text', 'custom_text:add');
}
