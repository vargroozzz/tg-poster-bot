import type { InlineKeyboardMarkup } from 'grammy/types';

export function createReplySlotKeyboard(sessionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '📎 Same slot as parent', callback_data: `reply_slot:together:${sessionId}` },
        { text: '⏭ Next available slot', callback_data: `reply_slot:separated:${sessionId}` },
      ],
    ],
  };
}
