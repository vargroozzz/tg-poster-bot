import { describe, it, expect } from 'vitest';
import type { Message } from 'grammy/types';
import { extractMessageContent } from '../forward.handler.js';

describe('extractMessageContent — voice', () => {
  it('extracts a voice message with its caption', () => {
    const message = {
      message_id: 1,
      voice: { file_id: 'voice-file-id', duration: 5, file_unique_id: 'u' },
      caption: 'listen',
    } as unknown as Message;

    expect(extractMessageContent(message)).toEqual({
      type: 'voice',
      fileId: 'voice-file-id',
      text: 'listen',
    });
  });
});
