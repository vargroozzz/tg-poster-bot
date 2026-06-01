import type { InlineKeyboardMarkup } from 'grammy/types';

export function createPreviewActionKeyboard(sessionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Schedule', callback_data: `preview:schedule:${sessionId}` },
        { text: '❌ Cancel', callback_data: `preview:cancel:${sessionId}` },
      ],
      [
        { text: '⬅️ Back to start', callback_data: `preview:back:${sessionId}` },
      ],
    ],
  };
}
