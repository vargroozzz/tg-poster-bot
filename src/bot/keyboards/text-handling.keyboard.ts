import { InlineKeyboard } from 'grammy';

export function createTextHandlingKeyboard() {
  return new InlineKeyboard()
    .text('Keep text', 'text:keep')
    .text('Remove text', 'text:remove')
    .row()
    .text('Wrap in quote', 'text:quote');
}
