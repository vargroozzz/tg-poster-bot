import { describe, it, expect } from 'vitest';
import { parseForwardInfo } from '../message-parser.js';
import type { Message } from 'grammy/types';

function makeBase(extra: Partial<Message> = {}): Message {
  return {
    message_id: 100,
    date: 0,
    chat: { id: 999, type: 'private' },
    ...extra,
  } as Message;
}

describe('parseForwardInfo — external_reply', () => {
  it('returns base info for plain non-forwarded message', () => {
    const msg = makeBase();
    const result = parseForwardInfo(msg);
    expect(result.messageId).toBe(100);
    expect(result.chatId).toBe(999);
    expect(result.fromChannelId).toBeUndefined();
    expect(result.replyParameters).toBeUndefined();
  });

  it('extracts channel origin from external_reply', () => {
    const msg = makeBase({
      external_reply: {
        origin: {
          type: 'channel',
          date: 0,
          chat: { id: -1001, type: 'channel', title: 'Test Chan', username: 'testchan' },
          message_id: 42,
        },
        chat: { id: -1001, type: 'channel', title: 'Test Chan', username: 'testchan' },
        message_id: 42,
      },
    });

    const result = parseForwardInfo(msg);
    expect(result.fromChannelId).toBe(-1001);
    expect(result.fromChannelTitle).toBe('Test Chan');
    expect(result.fromChannelUsername).toBe('testchan');
    expect(result.messageLink).toBe('https://t.me/testchan/42');
    expect(result.replyParameters).toEqual({ chatId: -1001, messageId: 42 });
  });

  it('extracts user origin from external_reply', () => {
    const msg = makeBase({
      external_reply: {
        origin: {
          type: 'user',
          date: 0,
          sender_user: { id: 777, is_bot: false, first_name: 'Alice', username: 'alice' },
        },
        chat: { id: -1002, type: 'supergroup', title: 'Group' },
        message_id: 55,
      },
    });

    const result = parseForwardInfo(msg);
    expect(result.fromUserId).toBe(777);
    expect(result.fromUsername).toBe('alice');
    expect(result.replyParameters).toEqual({ chatId: -1002, messageId: 55 });
  });

  it('omits replyParameters when external_reply has no chat/message_id', () => {
    const msg = makeBase({
      external_reply: {
        origin: { type: 'hidden_user', date: 0, sender_user_name: 'Hidden' },
        // no chat, no message_id
      },
    });

    const result = parseForwardInfo(msg);
    expect(result.replyParameters).toBeUndefined();
  });
});
