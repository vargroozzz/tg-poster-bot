import { describe, it, expect, vi, beforeEach } from 'vitest';

const findById = vi.fn();
const deletePending = vi.fn();
const shiftPostsEarlier = vi.fn();
const releaseOrphanedReplies = vi.fn();

vi.mock('../../../database/repositories/scheduled-post.repository.js', () => ({
  ScheduledPostRepository: class {
    findById = findById;
    deletePending = deletePending;
    shiftPostsEarlier = shiftPostsEarlier;
    releaseOrphanedReplies = releaseOrphanedReplies;
  },
}));

const { QueueService } = await import('../queue.service.js');

const scheduledTime = new Date('2026-01-15T12:00:01Z');
const post = { targetChannelId: '-100123', scheduledTime };

describe('QueueService.deleteAndCascade', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes a pending post and shifts its successors earlier', async () => {
    findById.mockResolvedValue(post);
    deletePending.mockResolvedValue(true);
    releaseOrphanedReplies.mockResolvedValue(2);

    expect(await new QueueService().deleteAndCascade('p1')).toEqual({
      channelId: '-100123',
      deletedTime: scheduledTime,
      keptReplies: 2,
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
});
