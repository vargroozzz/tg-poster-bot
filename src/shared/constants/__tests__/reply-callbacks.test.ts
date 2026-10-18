import { describe, it, expect } from 'vitest';
import {
  REPLY_CALLBACK_PATTERN,
  REPLY_FROM_CONFIRMATION,
  REPLY_FROM_QUEUE,
  replyCallback,
} from '../reply-callbacks.js';

const ID = '0123456789abcdef01234567';

describe('reply callbacks', () => {
  it.each([REPLY_FROM_CONFIRMATION, REPLY_FROM_QUEUE])('round-trips %s, plain and quoted', (prefix) => {
    expect(replyCallback(prefix, ID).match(REPLY_CALLBACK_PATTERN)?.slice(1)).toEqual([prefix, undefined, ID]);
    expect(replyCallback(prefix, ID, true).match(REPLY_CALLBACK_PATTERN)?.slice(1)).toEqual([prefix, '_quote', ID]);
  });

  it('rejects a post id that is not an ObjectId', () => {
    expect(replyCallback(REPLY_FROM_QUEUE, 'p1')).not.toMatch(REPLY_CALLBACK_PATTERN);
  });
});
