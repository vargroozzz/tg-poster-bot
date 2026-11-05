import { describe, it, expect, vi, beforeEach } from 'vitest';

const findById = vi.fn();
const deletePending = vi.fn();
const shiftPostsEarlier = vi.fn();
const releaseOrphanedReplies = vi.fn();
const promoteSameSlotReplies = vi.fn();
const deleteSameSlotReplies = vi.fn();

vi.mock('../../../database/repositories/scheduled-post.repository.js', () => ({
  ScheduledPostRepository: class {
    findById = findById;
    deletePending = deletePending;
    shiftPostsEarlier = shiftPostsEarlier;
    releaseOrphanedReplies = releaseOrphanedReplies;
    promoteSameSlotReplies = promoteSameSlotReplies;
    deleteSameSlotReplies = deleteSameSlotReplies;
  },
}));

const { QueueService } = await import('../queue.service.js');

const scheduledTime = new Date('2026-01-15T12:00:01Z');
const post = { _id: 'p1', targetChannelId: '-100123', scheduledTime, sameSlot: false };

describe('QueueService.deleteAndCascade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    promoteSameSlotReplies.mockResolvedValue(null);
    deleteSameSlotReplies.mockResolvedValue([]);
  });

  it('deletes a pending post and shifts its successors earlier', async () => {
    findById.mockResolvedValue(post);
    deletePending.mockResolvedValue(true);
    releaseOrphanedReplies.mockResolvedValue(2);

    expect(await new QueueService().deleteAndCascade('p1')).toEqual({
      channelId: '-100123',
      deletedTime: scheduledTime,
      keptReplies: 2,
      droppedReplies: 0,
    });
    expect(shiftPostsEarlier).toHaveBeenCalledWith('-100123', scheduledTime);
    expect(releaseOrphanedReplies).toHaveBeenCalledWith(post);
  });

  // A channel move re-points the replies to the re-created post itself.
  it('leaves the replies to the caller on a move', async () => {
    findById.mockResolvedValue(post);
    deletePending.mockResolvedValue(true);

    expect(await new QueueService().deleteAndCascade('p1', { keepReplies: true })).toMatchObject({ keptReplies: 0 });
    expect(releaseOrphanedReplies).not.toHaveBeenCalled();
  });

  // Deleting here would erase a post that already went out and pull the rest of the queue
  // forward; the edit flow reads the null and skips rescheduling rather than double-posting.
  it('leaves the queue alone once the worker has published the post', async () => {
    findById.mockResolvedValue(post);
    deletePending.mockResolvedValue(false);

    expect(await new QueueService().deleteAndCascade('p1')).toBeNull();
    expect(shiftPostsEarlier).not.toHaveBeenCalled();
  });

  // Its same-slot reply in the same channel takes the freed slot, so there is no gap to close.
  it('leaves no gap when a kept same-slot reply takes the slot', async () => {
    findById.mockResolvedValue(post);
    deletePending.mockResolvedValue(true);
    promoteSameSlotReplies.mockResolvedValue({ targetChannelId: '-100123' });
    releaseOrphanedReplies.mockResolvedValue(1);

    expect(await new QueueService().deleteAndCascade('p1')).toMatchObject({ keptReplies: 1 });
    expect(shiftPostsEarlier).not.toHaveBeenCalled();
  });

  // It may have moved the heir into the freed slot before failing: shifting would collide.
  it('shifts nothing when the promotion fails, and still reports the delete', async () => {
    findById.mockResolvedValue(post);
    deletePending.mockResolvedValue(true);
    promoteSameSlotReplies.mockRejectedValue(new Error('mongo down'));
    releaseOrphanedReplies.mockResolvedValue(0);

    expect(await new QueueService().deleteAndCascade('p1')).toMatchObject({ channelId: '-100123' });
    expect(shiftPostsEarlier).not.toHaveBeenCalled();
  });

  it('closes the gap when the heir is in another channel', async () => {
    findById.mockResolvedValue(post);
    deletePending.mockResolvedValue(true);
    promoteSameSlotReplies.mockResolvedValue({ targetChannelId: '-100999' });
    releaseOrphanedReplies.mockResolvedValue(1);

    await new QueueService().deleteAndCascade('p1');
    expect(shiftPostsEarlier).toHaveBeenCalledWith('-100123', scheduledTime);
  });

  it('deletes the same-slot replies too when asked, keeping the replies to them', async () => {
    const dropped = { _id: 'r1' };
    findById.mockResolvedValue(post);
    deletePending.mockResolvedValue(true);
    deleteSameSlotReplies.mockResolvedValue([dropped]);
    releaseOrphanedReplies.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    expect(await new QueueService().deleteAndCascade('p1', { dropSameSlot: true })).toMatchObject({
      keptReplies: 1,
      droppedReplies: 1,
    });
    expect(promoteSameSlotReplies).not.toHaveBeenCalled();
    expect(releaseOrphanedReplies).toHaveBeenCalledWith(dropped);
    expect(shiftPostsEarlier).toHaveBeenCalled();
  });

  // A same-slot reply holds no slot of its own.
  it('shifts nothing when deleting a same-slot reply', async () => {
    findById.mockResolvedValue({ ...post, sameSlot: true });
    deletePending.mockResolvedValue(true);
    releaseOrphanedReplies.mockResolvedValue(0);

    await new QueueService().deleteAndCascade('p1');
    expect(promoteSameSlotReplies).not.toHaveBeenCalled();
    expect(shiftPostsEarlier).not.toHaveBeenCalled();
  });
});
