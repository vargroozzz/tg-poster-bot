import type { InlineKeyboardMarkup } from 'grammy/types';
import { POST_FLOW, type FlowCallbacks } from './flow-callbacks.js';

// A reply can't be forwarded: forwardMessage takes no reply_parameters, so the "Forwarded
// from" header and the reply thread can't both survive. Replies get no Forward button.
export function createForwardActionKeyboard(
  cb: FlowCallbacks = POST_FLOW,
  isReply = false
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '⚡ Quick post', callback_data: cb('action', 'quick'), style: 'primary' }],
      [
        { text: '✨ Transform', callback_data: cb('action', 'transform') },
        ...(isReply ? [] : [{ text: '➡️ Forward', callback_data: cb('action', 'forward') }]),
      ],
    ],
  };
}
