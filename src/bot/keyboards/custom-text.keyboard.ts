import { InlineKeyboard } from 'grammy';
import { listCustomTextPresets } from '../../database/models/custom-text-preset.model.js';

export async function createCustomTextKeyboard(): Promise<InlineKeyboard> {
  const presets = await listCustomTextPresets();

  const rows: object[][] = presets.map((p) => [
    { text: p.label, callback_data: `custom_text:preset:${p._id}` },
  ]);

  rows.push([
    { text: 'Skip', callback_data: 'custom_text:skip', style: 'primary' },
    { text: '✍️ Add text', callback_data: 'custom_text:add' },
  ]);

  return { inline_keyboard: rows } as unknown as InlineKeyboard;
}
