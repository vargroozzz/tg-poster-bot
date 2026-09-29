import { describe, it, expect, vi } from 'vitest';
import type { Api } from 'grammy';
import { PostPublisherService } from '../post-publisher.service.js';
import type { EmbeddedReplyData } from '../../../database/models/scheduled-post.model.js';

describe('PostPublisherService.publishEmbeddedReply', () => {
  it('sends transform reply with reply_parameters to target channel', async () => {
    const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    const mockApi = {
      sendMessage: mockSendMessage,
      sendPhoto: vi.fn(),
      sendVideo: vi.fn(),
      sendDocument: vi.fn(),
      sendAnimation: vi.fn(),
      sendMediaGroup: vi.fn(),
    } as unknown as Api;

    const publisher = new PostPublisherService(mockApi);
    const replyData: EmbeddedReplyData = {
      targetChannelId: '-1001111',
      content: { type: 'text', text: 'hello reply' },
      action: 'transform',
      originalForward: { messageId: 1, chatId: 100 },
    };

    const msgId = await publisher.publishEmbeddedReply(replyData, 99, '-1002222');

    expect(msgId).toBe(42);
    expect(mockSendMessage).toHaveBeenCalledWith(
      '-1001111',
      'hello reply',
      expect.objectContaining({
        reply_parameters: { message_id: 99, chat_id: -1002222 },
      })
    );
  });

  it('copies forward reply with reply_parameters to target channel', async () => {
    const mockCopyMessage = vi.fn().mockResolvedValue({ message_id: 77 });
    const mockApi = {
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(),
      sendVideo: vi.fn(),
      sendDocument: vi.fn(),
      sendAnimation: vi.fn(),
      sendMediaGroup: vi.fn(),
      copyMessage: mockCopyMessage,
    } as unknown as Api;

    const publisher = new PostPublisherService(mockApi);
    const replyData: EmbeddedReplyData = {
      targetChannelId: '-1001111',
      content: { type: 'text', text: 'original' },
      action: 'forward',
      originalForward: { messageId: 55, chatId: 200 },
    };

    const msgId = await publisher.publishEmbeddedReply(replyData, 99, '-1002222');

    expect(msgId).toBe(77);
    expect(mockCopyMessage).toHaveBeenCalledWith(
      '-1001111',
      200,
      55,
      expect.objectContaining({
        reply_parameters: { message_id: 99, chat_id: -1002222 },
      })
    );
  });
});

describe('PostPublisherService reply quotes', () => {
  const quote = { text: 'part', position: 3 };
  const replyData: EmbeddedReplyData = {
    targetChannelId: '-1001111',
    content: { type: 'text', text: 'hello reply' },
    action: 'transform',
    originalForward: { messageId: 1, chatId: 100, replyQuote: quote },
  };

  it('quotes the parent', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    await new PostPublisherService({ sendMessage } as unknown as Api).publishEmbeddedReply(replyData, 99, '-1002222');
    expect(sendMessage).toHaveBeenCalledWith('-1001111', 'hello reply', expect.objectContaining({
      reply_parameters: { message_id: 99, chat_id: -1002222, quote: 'part', quote_position: 3 },
    }));
  });

  it('retries without the quote when Telegram rejects it', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('Call to sendMessage failed! (400: Bad Request: QUOTE_TEXT_INVALID)'))
      .mockResolvedValue({ message_id: 43 });
    const msgId = await new PostPublisherService({ sendMessage } as unknown as Api).publishEmbeddedReply(replyData, 99, '-1002222');
    expect(msgId).toBe(43);
    expect(sendMessage).toHaveBeenLastCalledWith('-1001111', 'hello reply', expect.objectContaining({
      reply_parameters: { message_id: 99, chat_id: -1002222 },
    }));
  });
});
