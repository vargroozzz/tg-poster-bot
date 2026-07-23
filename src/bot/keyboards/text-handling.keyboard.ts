import type { InlineKeyboardMarkup } from 'grammy/types';
import { listCustomTextPresets } from '../../database/models/custom-text-preset.model.js';

// One step, one tap: the post's text is either the original (keep / quote), a custom
// one (preset / typed), or none at all. Picking a custom text drops the original.
export async function createTextChoiceKeyboard(
  hasText: boolean,
  hasBlockquotes: boolean
): Promise<InlineKeyboardMarkup> {
  const presets = await listCustomTextPresets();

  // Blockquoted text can only be kept as-is — re-quoting it would nest blockquotes.
  const originalRow = hasBlockquotes
    ? [{ text: 'Keep text', callback_data: 'text:keep' }]
    : [
        { text: 'Keep text', callback_data: 'text:keep' },
        { text: 'Wrap in quote', callback_data: 'text:quote' },
      ];

  return {
    inline_keyboard: [
      ...(hasText ? [originalRow] : []),
      ...presets.map((p) => [{ text: p.label, callback_data: `custom_text:preset:${p._id}` }]),
      [
        { text: hasText ? 'Remove text' : 'No text', callback_data: 'text:remove', style: 'primary' as const },
        { text: '✍️ Add text', callback_data: 'custom_text:add' },
      ],
    ],
  };
}
