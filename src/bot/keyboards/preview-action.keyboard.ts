import { InlineKeyboard } from 'grammy';

/**
 * Creates keyboard for preview actions
 * User can schedule the post or cancel
 */
export function createPreviewActionKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard.text('✅ Schedule', 'preview:schedule');
  keyboard.text('❌ Cancel', 'preview:cancel');

  return keyboard;
}
