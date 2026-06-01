import type { InlineKeyboardMarkup } from 'grammy/types';
import { listCustomTextPresets } from '../../database/models/custom-text-preset.model.js';

export async function createCustomTextKeyboard(): Promise<InlineKeyboardMarkup> {
  const presets = await listCustomTextPresets();

  return {
    inline_keyboard: [
      ...presets.map((p) => [{ text: p.label, callback_data: `custom_text:preset:${p._id}` }]),
      [
        { text: 'Skip', callback_data: 'custom_text:skip', style: 'primary' as const },
        { text: '✍️ Add text', callback_data: 'custom_text:add' },
      ],
    ],
  };
}
