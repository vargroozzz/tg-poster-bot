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

// Owner-facing keyboard for a proposed post. Schedule/Cancel only.
// ponytail: TODO add a working "Back to adjust" button — it needs the proposer's content
// re-forwarded into the owner's chat and the session re-anchored so the mid-flow callbacks
// (which read the original message as a reply target) have something to reply to.
export function createProposalPreviewKeyboard(sessionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Schedule', callback_data: `preview:schedule:${sessionId}` },
        { text: '❌ Cancel', callback_data: `preview:cancel:${sessionId}` },
      ],
    ],
  };
}

export function createAddReplyKeyboard(postId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '💬 Add a reply', callback_data: `reply_trigger:${postId}` },
      ],
    ],
  };
}
