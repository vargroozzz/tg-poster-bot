import { describe, it, expect } from 'vitest';
import { saveQueuePreview, takeQueuePreview, takeQueuePreviewsOfPost } from '../queue-preview-state.js';

const preview = (postId: string, controlMessageId: number) => ({
  previewMessageIds: [controlMessageId - 1],
  postId,
  controlMessageId,
  queueMessageId: 1,
  channelId: '-100123',
  page: 1,
});

describe('queue preview state', () => {
  it('keeps each open preview under its own control message', () => {
    const userId = 1;
    saveQueuePreview(userId, preview('postA', 11));
    saveQueuePreview(userId, preview('postB', 21));

    expect(takeQueuePreview(userId, 21)?.postId).toBe('postB');
    expect(takeQueuePreview(userId, 21)).toBeUndefined();
    expect(takeQueuePreview(userId, 11)?.postId).toBe('postA');
  });

  it('takes every preview of a post and leaves the others', () => {
    const userId = 2;
    saveQueuePreview(userId, preview('postA', 11));
    saveQueuePreview(userId, preview('postB', 21));
    saveQueuePreview(userId, preview('postA', 31));

    expect(takeQueuePreviewsOfPost(userId, 'postA').map((s) => s.controlMessageId)).toEqual([11, 31]);
    expect(takeQueuePreviewsOfPost(userId, 'postA')).toEqual([]);
    expect(takeQueuePreview(userId, 21)?.postId).toBe('postB');
  });

  it('keeps users apart', () => {
    saveQueuePreview(3, preview('postC', 41));
    expect(takeQueuePreview(4, 41)).toBeUndefined();
    expect(takeQueuePreviewsOfPost(4, 'postC')).toEqual([]);
    expect(takeQueuePreview(3, 41)?.postId).toBe('postC');
  });
});
