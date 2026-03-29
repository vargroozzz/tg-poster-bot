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

  it('extracts only replyParameters from external_reply (channel origin)', () => {
    // external_reply.origin identifies the *quoted* entity, not the author.
    // fromChannelId must NOT be set so attribution is not wrongly attributed
    // to the channel being quoted.
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
    expect(result.fromChannelId).toBeUndefined();
    expect(result.fromChannelTitle).toBeUndefined();
    expect(result.fromChannelUsername).toBeUndefined();
    expect(result.messageLink).toBeUndefined();
    expect(result.replyParameters).toEqual({ chatId: -1001, messageId: 42 });
  });

  it('extracts only replyParameters from external_reply (user origin)', () => {
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
    expect(result.fromUserId).toBeUndefined();
    expect(result.fromUsername).toBeUndefined();
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

describe('parseForwardInfo — forward_origin with external_reply', () => {
  it('captures replyParameters from external_reply even when forward_origin is set', () => {
    const msg = makeBase({
      forward_origin: {
        type: 'channel',
        date: 0,
        chat: { id: -2001, type: 'channel', title: 'Source Chan', username: 'sourcechan' },
        message_id: 10,
      },
      external_reply: {
        origin: {
          type: 'channel',
          date: 0,
          chat: { id: -3001, type: 'channel', title: 'Quoted Chan', username: 'quotedchan' },
          message_id: 20,
        },
        chat: { id: -3001, type: 'channel', title: 'Quoted Chan', username: 'quotedchan' },
        message_id: 20,
      },
    });

    const result = parseForwardInfo(msg);
    // fromChannelId comes from forward_origin (the actual source)
    expect(result.fromChannelId).toBe(-2001);
    expect(result.fromChannelTitle).toBe('Source Chan');
    expect(result.messageLink).toBe('https://t.me/sourcechan/10');
    // replyParameters come from external_reply (what it was replying to)
    expect(result.replyParameters).toEqual({ chatId: -3001, messageId: 20 });
  });

  it('captures replyParameters for forwarded user message that was a reply', () => {
    const msg = makeBase({
      forward_origin: {
        type: 'user',
        date: 0,
        sender_user: { id: 42, is_bot: false, first_name: 'Bob', username: 'bob' },
      },
      external_reply: {
        origin: {
          type: 'channel',
          date: 0,
          chat: { id: -4001, type: 'channel', title: 'Some Chan', username: 'somechan' },
          message_id: 99,
        },
        chat: { id: -4001, type: 'channel', title: 'Some Chan', username: 'somechan' },
        message_id: 99,
      },
    });

    const result = parseForwardInfo(msg);
    expect(result.fromUserId).toBe(42);
    expect(result.fromUsername).toBe('bob');
    expect(result.replyParameters).toEqual({ chatId: -4001, messageId: 99 });
  });
});
