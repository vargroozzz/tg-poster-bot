import type { InlineKeyboardMarkup } from 'grammy/types';
import { POST_FLOW, type FlowCallbacks } from './flow-callbacks.js';

export function createForwardActionKeyboard(cb: FlowCallbacks = POST_FLOW): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '⚡ Quick post', callback_data: cb('action', 'quick'), style: 'primary' }],
      [
        { text: '✨ Transform', callback_data: cb('action', 'transform') },
        { text: '➡️ Forward', callback_data: cb('action', 'forward') },
      ],
    ],
  };
}
