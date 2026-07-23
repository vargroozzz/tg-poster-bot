import type { InlineKeyboardMarkup } from 'grammy/types';
import { listCustomTextPresets } from '../../database/models/custom-text-preset.model.js';

export type TextHandling = 'remove' | 'keep' | 'quote';

const HANDLING_LABELS: Record<TextHandling, string> = {
  remove: 'Remove text',
  keep: 'Keep text',
  quote: 'Wrap in quote',
};

// One step, two choices: the handling row is a toggle (re-renders with ✅), the
// preset / Skip / Add text buttons commit and move the flow on.
export async function createTextCustomKeyboard(
  selected: TextHandling,
  showHandling: boolean
): Promise<InlineKeyboardMarkup> {
  const presets = await listCustomTextPresets();

  const handlingRow = Object.entries(HANDLING_LABELS).map(([key, label]) => ({
    text: key === selected ? `✅ ${label}` : label,
    callback_data: `text:${key}`,
  }));

  return {
    inline_keyboard: [
      ...(showHandling ? [handlingRow] : []),
      ...presets.map((p) => [{ text: p.label, callback_data: `custom_text:preset:${p._id}` }]),
      [
        { text: 'Skip', callback_data: 'custom_text:skip', style: 'primary' as const },
        { text: '✍️ Add text', callback_data: 'custom_text:add' },
      ],
    ],
  };
}
