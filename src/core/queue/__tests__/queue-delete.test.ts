import { describe, it, expect, vi, beforeEach } from 'vitest';

const findById = vi.fn();
const deletePending = vi.fn();
const shiftPostsEarlier = vi.fn();

vi.mock('../../../database/repositories/scheduled-post.repository.js', () => ({
  ScheduledPostRepository: class {
    findById = findById;
    deletePending = deletePending;
    shiftPostsEarlier = shiftPostsEarlier;
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

    expect(await new QueueService().deleteAndCascade('p1')).toEqual({
      channelId: '-100123',
      deletedTime: scheduledTime,
    });
    expect(shiftPostsEarlier).toHaveBeenCalledWith('-100123', scheduledTime);
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
