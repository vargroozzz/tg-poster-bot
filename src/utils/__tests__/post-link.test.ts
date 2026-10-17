import { describe, it, expect } from 'vitest';
import { findLinkedPost, isPostLink } from '../post-link.js';

const channels = [
  { channelId: '-1001234567890', channelUsername: 'MyChannel' },
  { channelId: '-1009999999999', channelUsername: null },
];

describe('findLinkedPost', () => {
  it('matches a public post link by username, case-insensitively', () => {
    expect(findLinkedPost('https://t.me/mychannel/42', channels)).toEqual({
      channel: channels[0],
      messageId: 42,
    });
  });

  it('matches a private post link by internal id', () => {
    expect(findLinkedPost('https://t.me/c/9999999999/7', channels)).toEqual({
      channel: channels[1],
      messageId: 7,
    });
  });

  it('accepts no scheme, telegram.me, a query string and surrounding whitespace', () => {
    expect(findLinkedPost('  t.me/MyChannel/5?single ', channels)?.messageId).toBe(5);
    expect(findLinkedPost('http://telegram.me/MyChannel/6/', channels)?.messageId).toBe(6);
  });

  it('ignores links to channels that are not posting channels', () => {
    expect(findLinkedPost('https://t.me/otherchannel/42', channels)).toBeUndefined();
    expect(findLinkedPost('https://t.me/c/1111111111/42', channels)).toBeUndefined();
  });

  it('ignores text that is more than a link, or no link at all', () => {
    expect(findLinkedPost('look https://t.me/MyChannel/42', channels)).toBeUndefined();
    expect(findLinkedPost('https://t.me/MyChannel', channels)).toBeUndefined();
    expect(findLinkedPost(undefined, channels)).toBeUndefined();
  });
});

describe('isPostLink', () => {
  it('accepts any post link, posting channel or not, and nothing else', () => {
    expect(isPostLink('https://t.me/otherchannel/42')).toBe(true);
    expect(isPostLink(' t.me/c/1111111111/42 ')).toBe(true);
    expect(isPostLink('hello')).toBe(false);
    expect(isPostLink(undefined)).toBe(false);
  });
});
