import { describe, it, expect } from 'vitest';
import { flowCallbacks } from '../flow-callbacks.js';
import { NICKNAME_NONE_KEY } from '../nickname-select.keyboard.js';
import { ACTION_CHOICES, editStepPattern, TEXT_CHOICES } from '../../../shared/constants/edit-callbacks.js';

const SID = 'aaaaaaaaaaaaaaaaaaaaaaaa'; // 24-char session id

// The encodings the callback handlers' regexes are written against — a typo here (or there)
// produces buttons no handler matches, which compiles and lints just fine.
describe('flowCallbacks', () => {
  it('encodes every step for the post flow', () => {
    const cb = flowCallbacks('post');
    expect([
      cb('channel', '-100123'),
      cb('action', 'quick'),
      cb('text', 'keep'),
      cb('preset', 'p1'),
      cb('addText'),
      cb('nickname', '42'),
    ]).toEqual([
      'select_channel:-100123',
      'action:quick',
      'text:keep',
      'custom_text:preset:p1',
      'custom_text:add',
      'select_nickname:42',
    ]);
  });

  it('encodes every step for the edit flow, keyed by session id', () => {
    const cb = flowCallbacks('edit', SID);
    expect([
      cb('channel', '-100123'),
      cb('action', 'quick'),
      cb('text', 'keep'),
      cb('preset', 'p1'),
      cb('addText'),
      cb('nickname', '42'),
    ]).toEqual([
      `queue:edit:ch:${SID}:-100123`,
      `queue:edit:action:${SID}:quick`,
      `queue:edit:text:${SID}:keep`,
      `ec:preset:${SID}:p1`,
      `queue:edit:custom:${SID}:add`,
      `queue:edit:nickname:${SID}:42`,
    ]);
  });

  // What the keyboards emit against what the edit handlers listen for, every value of every step.
  it.each([
    ['channel', '-100123'],
    ...ACTION_CHOICES.map((action) => ['action', action] as const),
    ...TEXT_CHOICES.map((handling) => ['text', handling] as const),
    ['preset', 'b'.repeat(24)],
    ['addText', undefined],
    ['nickname', '42'],
    ['nickname', NICKNAME_NONE_KEY],
  ] as const)('the edit handler pattern matches the %s step with %s', (step, value) => {
    const match = flowCallbacks('edit', SID)(step, value).match(editStepPattern(step));
    expect(match?.[1]).toBe(SID);
    if (value !== undefined) expect(match?.[2]).toBe(value);
  });

  it('stays inside Telegram’s 64-byte callback_data cap with 24-char ids', () => {
    const cb = flowCallbacks('edit', SID);
    const longest = cb('preset', 'bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(Buffer.byteLength(longest)).toBeLessThanOrEqual(64);
  });
});
