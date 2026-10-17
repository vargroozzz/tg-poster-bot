import { describe, it, expect } from 'vitest';
import { createForwardActionKeyboard } from '../forward-action.keyboard.js';

const callbacks = (isReply?: boolean): string[] =>
  createForwardActionKeyboard(undefined, isReply).inline_keyboard.flat().map((b) =>
    'callback_data' in b ? b.callback_data ?? '' : ''
  );

describe('createForwardActionKeyboard', () => {
  it('offers Forward for a regular post', () => {
    expect(callbacks()).toEqual(['action:quick', 'action:transform', 'action:forward']);
  });

  it('drops Forward for a reply', () => {
    expect(callbacks(true)).toEqual(['action:quick', 'action:transform']);
  });
});
