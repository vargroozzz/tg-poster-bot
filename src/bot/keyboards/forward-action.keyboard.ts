import { InlineKeyboard } from 'grammy';

export function createForwardActionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✨ Transform & Schedule', 'action:transform')
    .text('➡️ Forward As-Is', 'action:forward');
}
