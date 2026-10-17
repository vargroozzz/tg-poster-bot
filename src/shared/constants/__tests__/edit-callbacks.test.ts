import { describe, it, expect } from 'vitest';
import { EDIT_POST_PATTERN, editPostCallback, editStepCallback, editStepPattern } from '../edit-callbacks.js';

describe('edit callbacks', () => {
  const postId = 'a'.repeat(24);

  it('round-trips the post id', () => {
    expect(editPostCallback(postId).match(EDIT_POST_PATTERN)?.[1]).toBe(postId);
  });

  it("doesn't match the edit flow's step callbacks", () => {
    expect(editStepCallback('text', postId, 'keep')).not.toMatch(EDIT_POST_PATTERN);
  });

  it("round-trips a step's session id and value", () => {
    expect(editStepCallback('channel', postId, '-100123').match(editStepPattern('channel'))?.slice(1)).toEqual([
      postId,
      '-100123',
    ]);
  });
});
