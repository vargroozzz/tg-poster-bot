import { InlineKeyboard } from 'grammy';

export function createCustomTextKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard.text('Add custom text', 'custom_text:add');
  keyboard.text('Skip', 'custom_text:skip');

  return keyboard;
}
