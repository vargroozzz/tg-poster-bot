import { InlineKeyboard } from 'grammy';

/**
 * Creates keyboard for preview actions
 * User can schedule the post or cancel
 * @param sessionId - The session ID to embed in callback data for lookup
 */
export function createPreviewActionKeyboard(sessionId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard.text('✅ Schedule', `preview:schedule:${sessionId}`);
  keyboard.text('❌ Cancel', `preview:cancel:${sessionId}`);

  return keyboard;
}
