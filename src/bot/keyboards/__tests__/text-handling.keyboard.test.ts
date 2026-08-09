import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../database/models/custom-text-preset.model.js', () => ({
  listCustomTextPresets: async () => [{ _id: 'p1', label: 'Subscribe!' }],
}));

const { createTextChoiceKeyboard } = await import('../text-handling.keyboard.js');
const { flowCallbacks } = await import('../flow-callbacks.js');

const callbacks = async (
  hasText: boolean,
  hasBlockquotes: boolean,
  cb?: Parameters<typeof createTextChoiceKeyboard>[2]
): Promise<string[]> => {
  const kb = await createTextChoiceKeyboard(hasText, hasBlockquotes, cb);
  return (kb.inline_keyboard as Array<Array<{ callback_data: string }>>)
    .flat()
    .map((b) => b.callback_data);
};

describe('createTextChoiceKeyboard', () => {
  it('offers keep and quote for plain text', async () => {
    expect(await callbacks(true, false)).toEqual([
      'text:keep',
      'text:quote',
      'custom_text:preset:p1',
      'text:remove',
      'custom_text:add',
    ]);
  });

  it('offers keep but not quote for blockquoted text (no nesting)', async () => {
    const data = await callbacks(true, true);
    expect(data).toContain('text:keep');
    expect(data).not.toContain('text:quote');
  });

  it('offers no original-text options when there is no text', async () => {
    expect(await callbacks(false, false)).toEqual([
      'custom_text:preset:p1',
      'text:remove',
      'custom_text:add',
    ]);
  });

  it('renders the same step for the edit flow, with session-keyed callbacks', async () => {
    const sid = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    expect(await callbacks(true, false, flowCallbacks('edit', sid))).toEqual([
      `queue:edit:text:${sid}:keep`,
      `queue:edit:text:${sid}:quote`,
      `ec:preset:${sid}:p1`,
      `queue:edit:text:${sid}:remove`,
      `queue:edit:custom:${sid}:add`,
    ]);
  });

  it('always offers a custom text and a no-text option', async () => {
    for (const [hasText, hasBlockquotes] of [[true, false], [true, true], [false, false]] as const) {
      const data = await callbacks(hasText, hasBlockquotes);
      expect(data).toContain('custom_text:add');
      expect(data).toContain('text:remove');
    }
  });
});
