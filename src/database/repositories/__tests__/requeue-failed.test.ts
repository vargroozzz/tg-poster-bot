import { describe, it, expect, vi } from 'vitest';
import { ScheduledPostRepository, PARENT_FAILED } from '../scheduled-post.repository.js';

const slot = new Date('2026-11-26T12:00:01Z');

// Replies by parent id: p1 ← r1 ← r2, and p1 ← r3.
const tree: Record<string, string[]> = { p1: ['r1', 'r3'], r1: ['r2'] };

const repoWith = (requeued: object | null) => {
  const model = {
    findOneAndUpdate: vi.fn().mockResolvedValue(requeued),
    find: vi.fn(async ({ parentPostId }: { parentPostId: string }) =>
      (tree[parentPostId] ?? []).map((id) => ({ _id: { toString: () => id } }))
    ),
    updateMany: vi.fn().mockResolvedValue({}),
  };
  const repo = new ScheduledPostRepository();
  Reflect.set(repo, 'model', model);
  return { repo, model };
};

describe('ScheduledPostRepository.requeueFailed', () => {
  it('requeues the post in its own slot and brings back the replies that failed with it', async () => {
    const { repo, model } = repoWith({ _id: 'p1' });

    expect(await repo.requeueFailed('p1', slot)).toBe(3);
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'p1', status: 'failed' },
      expect.objectContaining({ $set: { status: 'pending', scheduledTime: slot, sameSlot: false } })
    );
    expect(model.find).toHaveBeenCalledWith({ parentPostId: 'p1', status: 'failed', error: PARENT_FAILED }, { _id: 1 });
    expect(model.updateMany).toHaveBeenCalledWith({ slotPostId: 'p1', sameSlot: true }, { $set: { scheduledTime: slot } });
  });

  it('does nothing to a post that is no longer failed', async () => {
    const { repo, model } = repoWith(null);

    expect(await repo.requeueFailed('p1', slot)).toBeNull();
    expect(model.updateMany).not.toHaveBeenCalled();
  });
});
