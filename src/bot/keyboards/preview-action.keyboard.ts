import { InlineKeyboard } from 'grammy';

/**
 * Creates keyboard for preview actions
 * User can schedule the post or cancel
 * @param sessionId - The session ID to embed in callback data for lookup
 */
export function createPreviewActionKeyboard(sessionId: string): InlineKeyboard {
  return {
    inline_keyboard: [[
      { text: '✅ Schedule', callback_data: `preview:schedule:${sessionId}`, style: 'success' },
      { text: '❌ Cancel', callback_data: `preview:cancel:${sessionId}`, style: 'danger' },
    ]],
  } as unknown as InlineKeyboard;
}
