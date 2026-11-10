import { describe, it, expect } from 'vitest';
import { toReplyParameters } from '../media-sender.service.js';

describe('toReplyParameters', () => {
  it('sends a plain quote as quote/quote_entities', () => {
    const entities = [{ type: 'bold' as const, offset: 0, length: 4 }];
    expect(
      toReplyParameters({ chatId: 1, messageId: 2, quote: { text: 'part', position: 3, entities } })
    ).toEqual({
      chat_id: 1,
      message_id: 2,
      quote: 'part',
      quote_entities: entities,
      quote_position: 3,
    });
  });

  it('sends an empty-text rich quote as quote_rich_texts only', () => {
    const richTexts = ['a ', { type: 'bold' as const, text: 'rich' }];
    expect(
      toReplyParameters({ chatId: 1, messageId: 2, quote: { text: '', position: 0, richTexts } })
    ).toEqual({
      chat_id: 1,
      message_id: 2,
      quote_rich_texts: richTexts,
      quote_position: 0,
    });
  });

  it('sends a rich quote with text as both', () => {
    const richTexts = [{ type: 'bold' as const, text: 'rich' }];
    expect(
      toReplyParameters({
        chatId: 1,
        messageId: 2,
        quote: { text: 'rich', position: 4, richTexts },
      })
    ).toEqual({
      chat_id: 1,
      message_id: 2,
      quote: 'rich',
      quote_rich_texts: richTexts,
      quote_position: 4,
    });
  });
});
