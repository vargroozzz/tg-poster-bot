import { InlineKeyboard } from 'grammy';

export function createForwardActionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('⚡ Quick post', 'action:quick')
    .row()
    .text('✨ Transform', 'action:transform')
    .text('➡️ Forward', 'action:forward');
}
