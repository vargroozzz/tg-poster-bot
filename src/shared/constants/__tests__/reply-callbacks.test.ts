import { describe, it, expect } from 'vitest';
import {
  REPLY_CALLBACK_PATTERN,
  REPLY_FROM_CONFIRMATION,
  REPLY_FROM_QUEUE,
  replyCallback,
} from '../reply-callbacks.js';

describe('reply callbacks', () => {
  it.each([REPLY_FROM_CONFIRMATION, REPLY_FROM_QUEUE])('round-trips %s, plain and quoted', (prefix) => {
    expect(replyCallback(prefix, 'p1').match(REPLY_CALLBACK_PATTERN)?.slice(1)).toEqual([prefix, undefined, 'p1']);
    expect(replyCallback(prefix, 'p1', true).match(REPLY_CALLBACK_PATTERN)?.slice(1)).toEqual([prefix, '_quote', 'p1']);
  });
});
