import { describe, it, expect, vi } from 'vitest';

const slot = new Date('2026-11-26T12:00:01Z');
vi.mock('../../../utils/time-slots.js', () => ({ findNextAvailableSlot: vi.fn(async () => slot) }));

const { ScheduledPostRepository, PARENT_FAILED } = await import('../scheduled-post.repository.js');

// Replies by parent id: p1 ← r1 ← r2, and p1 ← r3.
const tree: Record<string, string[]> = { p1: ['r1', 'r3'], r1: ['r2'] };

const repoWith = (failed: object | null) => {
  const model = {
    findOne: vi.fn().mockResolvedValue(failed),
    findOneAndUpdate: vi.fn().mockResolvedValue(failed),
    find: vi.fn(async ({ parentPostId }: { parentPostId: string }) =>
      (tree[parentPostId] ?? []).map((id) => ({ _id: { toString: () => id } }))
    ),
    updateMany: vi.fn().mockResolvedValue({}),
  };
  const repo = new ScheduledPostRepository();
  Reflect.set(repo, 'model', model);
  return { repo, model };
};

describe('ScheduledPostRepository.requeueIfFailed', () => {
  it('requeues the post in its own slot and brings back the replies that failed with it', async () => {
    const { repo, model } = repoWith({ _id: 'p1', targetChannelId: '-100123' });

    expect(await repo.requeueIfFailed('p1')).toBe(slot);
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'p1', status: 'failed' },
      expect.objectContaining({ $set: { status: 'pending', scheduledTime: slot, sameSlot: false } })
    );
    expect(model.find).toHaveBeenCalledWith({ parentPostId: 'p1', status: 'failed', error: PARENT_FAILED }, { _id: 1 });
    expect(model.updateMany).toHaveBeenCalledWith({ slotPostId: 'p1', sameSlot: true }, { $set: { scheduledTime: slot } });
    // r1, r2 (under r1) and r3 back to waiting on their parents.
    expect(model.updateMany).toHaveBeenCalledTimes(3);
  });

  it('does nothing to a post that is not failed', async () => {
    const { repo, model } = repoWith(null);

    expect(await repo.requeueIfFailed('p1')).toBeNull();
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    expect(model.updateMany).not.toHaveBeenCalled();
  });
});

describe('ScheduledPostRepository.deleteIfFailed', () => {
  it('deletes only a failed post', async () => {
    const repo = new ScheduledPostRepository();
    const findOneAndDelete = vi.fn().mockResolvedValueOnce({ _id: 'p1' }).mockResolvedValueOnce(null);
    Reflect.set(repo, 'model', { findOneAndDelete });

    expect(await repo.deleteIfFailed('p1')).toBe(true);
    expect(await repo.deleteIfFailed('p2')).toBe(false);
    expect(findOneAndDelete).toHaveBeenCalledWith({ _id: 'p1', status: 'failed' });
  });
});
