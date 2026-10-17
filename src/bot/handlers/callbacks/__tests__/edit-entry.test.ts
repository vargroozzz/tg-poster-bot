import { describe, it, expect } from 'vitest';
import { editEntryBlocker } from '../edit-entry.js';

describe('editEntryBlocker', () => {
  it('blocks an already published post', () => {
    expect(editEntryBlocker({ status: 'posted' }, 1)).toMatch(/already published/);
  });

  it('blocks a failed post, which an edit could never save', () => {
    expect(editEntryBlocker({ status: 'failed' }, 1)).toMatch(/no longer queued/);
  });

  it('blocks when no posting channels exist', () => {
    expect(editEntryBlocker({ status: 'pending' }, 0)).toMatch(/No posting channels/);
  });

  it('lets a queued post with a channel through', () => {
    expect(editEntryBlocker({ status: 'pending' }, 1)).toBeUndefined();
    expect(editEntryBlocker({ status: 'waiting_parent' }, 2)).toBeUndefined();
  });
});
