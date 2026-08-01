import type { InlineKeyboardMarkup } from 'grammy/types';

// `textPlacement` is where the caption sits right now; the button offers the other one.
// Omit it for posts whose media can't carry a caption above (see supportsTextAbove).
export function createPreviewActionKeyboard(
  sessionId: string,
  textPlacement?: 'above' | 'below'
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Schedule', callback_data: `preview:schedule:${sessionId}` },
        { text: '❌ Cancel', callback_data: `preview:cancel:${sessionId}` },
      ],
      ...(textPlacement
        ? [[{
            text: textPlacement === 'above' ? '⬇️ Text below' : '⬆️ Text above',
            callback_data: `preview:textpos:${sessionId}`,
          }]]
        : []),
      [
        { text: '⬅️ Back to start', callback_data: `preview:back:${sessionId}` },
      ],
    ],
  };
}

// Owner-facing keyboard for a proposed post. Schedule/Cancel, plus an optional "Back to
// adjust" that re-homes the proposal into the owner's chat for editing. Back is only
// offered for single-message proposals — albums/threads can't be cleanly re-anchored
// without losing their grouping, so those stay Schedule/Cancel only.
export function createProposalPreviewKeyboard(
  sessionId: string,
  includeBack = false
): InlineKeyboardMarkup {
  const rows = [
    [
      { text: '✅ Schedule', callback_data: `preview:schedule:${sessionId}` },
      { text: '❌ Cancel', callback_data: `preview:cancel:${sessionId}` },
    ],
  ];
  if (includeBack) {
    rows.push([{ text: '⬅️ Back to adjust', callback_data: `preview:back:${sessionId}` }]);
  }
  return { inline_keyboard: rows };
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
