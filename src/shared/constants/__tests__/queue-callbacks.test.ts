import { describe, it, expect } from 'vitest';
import { QUEUE_DELETE_PATTERN, queueDeleteCallback } from '../queue-callbacks.js';

describe('queue callbacks', () => {
  it('round-trips the post id', () => {
    const postId = 'a'.repeat(24);
    expect(queueDeleteCallback(postId).match(QUEUE_DELETE_PATTERN)?.[1]).toBe(postId);
  });

  it('matches only an ObjectId', () => {
    expect(QUEUE_DELETE_PATTERN.test(queueDeleteCallback('a'.repeat(25)))).toBe(false);
    expect(QUEUE_DELETE_PATTERN.test(queueDeleteCallback('not-an-id'))).toBe(false);
  });
});
