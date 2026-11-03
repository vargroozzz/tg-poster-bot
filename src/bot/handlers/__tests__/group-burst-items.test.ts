import { describe, it, expect } from 'vitest';
import type { Message } from 'grammy/types';
import { groupBurstItems } from '../forward.handler.js';

const msg = (message_id: number, media_group_id?: string): Message =>
  ({ message_id, ...(media_group_id ? { media_group_id } : {}) }) as unknown as Message;

const ids = (items: Message[][]) => items.map((item) => item.map((m) => m.message_id));

describe('groupBurstItems', () => {
  it('makes each standalone message its own post, in arrival order', () => {
    expect(ids(groupBurstItems([msg(3), msg(1), msg(2)]))).toEqual([[1], [2], [3]]);
  });

  it('keeps an album as one post among standalone messages', () => {
    const burst = [msg(1), msg(2, 'a'), msg(4), msg(3, 'a'), msg(5, 'b'), msg(6, 'b')];
    expect(ids(groupBurstItems(burst))).toEqual([[1], [2, 3], [4], [5, 6]]);
  });
});
