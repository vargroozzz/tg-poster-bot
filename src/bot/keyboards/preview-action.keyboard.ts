import type { InlineKeyboardMarkup, InlineKeyboardButton } from 'grammy/types';
import type { SpoilerSlot } from '../../core/sending/spoilers.js';

const ITEMS_PER_ROW = 4;

// One button per spoiler-capable medium, labelled with its real album position — a
// document sitting among photos leaves a gap rather than shifting the numbering.
function spoilerMenuRows(sessionId: string, slots: SpoilerSlot[]): InlineKeyboardButton[][] {
  // Session id before the index: previewCallback reads the session from match[1].
  const buttons = slots.map((slot) => ({
    text: `${slot.on ? '🫥' : '⬜'} ${slot.index + 1}`,
    callback_data: `preview:spoiler:${sessionId}:${slot.index}`,
  }));

  return [
    ...Array.from({ length: Math.ceil(buttons.length / ITEMS_PER_ROW) }, (_, row) =>
      buttons.slice(row * ITEMS_PER_ROW, (row + 1) * ITEMS_PER_ROW)
    ),
    [{ text: '⬅️ Done', callback_data: `preview:spoilermenu:${sessionId}` }],
  ];
}

function spoilerRows(
  sessionId: string,
  slots: SpoilerSlot[],
  menuOpen: boolean
): InlineKeyboardButton[][] {
  if (slots.length === 0) return [];
  if (menuOpen && slots.length > 1) return spoilerMenuRows(sessionId, slots);

  const allOn = slots.every((slot) => slot.on);
  const toggleAll = {
    text: slots.length > 1
      ? (allOn ? '👁 Unspoiler all' : '🫥 Spoiler all')
      : (allOn ? '👁 Unspoiler' : '🫥 Spoiler'),
    callback_data: `preview:spoilerall:${sessionId}`,
  };

  return [
    slots.length > 1
      ? [toggleAll, { text: '🎚 Per item', callback_data: `preview:spoilermenu:${sessionId}` }]
      : [toggleAll],
  ];
}

// `textPlacement` is where the caption sits right now; the button offers the other one.
// Omit it for posts whose media can't carry a caption above (see supportsTextAbove).
// `spoilerSlots` is empty for posts with no spoiler-capable media, which drops the row.
export function createPreviewActionKeyboard(
  sessionId: string,
  textPlacement?: 'above' | 'below',
  spoilerSlots: SpoilerSlot[] = [],
  spoilerMenuOpen = false
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
      ...spoilerRows(sessionId, spoilerSlots, spoilerMenuOpen),
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
        { text: '✏️ Edit', callback_data: `queue:edit:${postId}` },
      ],
    ],
  };
}
