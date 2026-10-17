import { describe, it, expect } from 'vitest';
import { EDIT_POST_PATTERN, editPostCallback } from '../edit-callbacks.js';

describe('edit callbacks', () => {
  const postId = 'a'.repeat(24);

  it('round-trips the post id', () => {
    expect(editPostCallback(postId).match(EDIT_POST_PATTERN)?.[1]).toBe(postId);
  });

  it("doesn't match the edit flow's step callbacks", () => {
    expect(`queue:edit:text:${postId}:keep`).not.toMatch(EDIT_POST_PATTERN);
  });
});
