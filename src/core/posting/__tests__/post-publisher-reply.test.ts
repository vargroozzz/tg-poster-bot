import { describe, it, expect, vi } from 'vitest';
import type { Api } from 'grammy';
import { PostPublisherService } from '../post-publisher.service.js';
import type { IScheduledPost } from '../../../database/models/scheduled-post.model.js';

// A reply released by its published parent: replyTo* names the parent's message.
const reply = (overrides: Partial<IScheduledPost> = {}) =>
  ({
    targetChannelId: '-1001111',
    content: { type: 'text', text: 'hello reply' },
    action: 'transform',
    originalForward: { messageId: 1, chatId: 100 },
    replyToMessageId: 99,
    replyToChannelId: '-1002222',
    ...overrides,
  }) as IScheduledPost;

describe('PostPublisherService.publish, a reply', () => {
  it('sends a transform reply with reply_parameters to its own channel', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    expect(await new PostPublisherService({ sendMessage } as unknown as Api).publish(reply())).toBe(42);
    expect(sendMessage).toHaveBeenCalledWith('-1001111', 'hello reply', expect.objectContaining({
      reply_parameters: { message_id: 99, chat_id: -1002222 },
    }));
  });

  it('copies a forward reply, as forwardMessage takes no reply_parameters', async () => {
    const copyMessage = vi.fn().mockResolvedValue({ message_id: 77 });
    const post = reply({ action: 'forward', originalForward: { messageId: 55, chatId: 200 } });
    expect(await new PostPublisherService({ copyMessage } as unknown as Api).publish(post)).toBe(77);
    expect(copyMessage).toHaveBeenCalledWith('-1001111', 200, 55, expect.objectContaining({
      reply_parameters: { message_id: 99, chat_id: -1002222 },
    }));
  });

  const quoted = reply({ originalForward: { messageId: 1, chatId: 100, replyQuote: { text: 'part', position: 3 } } });

  it('quotes the parent', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    await new PostPublisherService({ sendMessage } as unknown as Api).publish(quoted);
    expect(sendMessage).toHaveBeenCalledWith('-1001111', 'hello reply', expect.objectContaining({
      reply_parameters: { message_id: 99, chat_id: -1002222, quote: 'part', quote_position: 3 },
    }));
  });

  it('retries without the quote when Telegram rejects it', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('Call to sendMessage failed! (400: Bad Request: QUOTE_TEXT_INVALID)'))
      .mockResolvedValue({ message_id: 43 });
    expect(await new PostPublisherService({ sendMessage } as unknown as Api).publish(quoted)).toBe(43);
    expect(sendMessage).toHaveBeenLastCalledWith('-1001111', 'hello reply', expect.objectContaining({
      reply_parameters: { message_id: 99, chat_id: -1002222 },
    }));
  });
});
