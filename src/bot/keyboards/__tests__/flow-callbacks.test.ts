import { describe, it, expect } from 'vitest';
import { flowCallbacks } from '../flow-callbacks.js';

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

  it('stays inside Telegram’s 64-byte callback_data cap with 24-char ids', () => {
    const cb = flowCallbacks('edit', SID);
    const longest = cb('preset', 'bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(Buffer.byteLength(longest)).toBeLessThanOrEqual(64);
  });
});
