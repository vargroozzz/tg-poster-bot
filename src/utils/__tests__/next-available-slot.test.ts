import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const latestPending = vi.fn();
vi.mock('../../database/models/scheduled-post.model.js', () => ({
  ScheduledPost: { findOne: () => ({ sort: latestPending }) },
  QUEUED_STATUSES: ['pending', 'waiting_parent'],
  HOLDS_SLOT: { sameSlot: { $ne: true } },
}));
vi.mock('../sleep-window.js', () => ({ getSleepWindow: async () => null, skipSleepWindow: (d: Date) => d }));
vi.mock('../post-interval.js', () => ({ getPostInterval: async () => 30 }));

const { findNextAvailableSlot } = await import('../time-slots.js');

// Kyiv = UTC+2 in January.
const kyiv = (h: number, m: number, s = 0) => new Date(Date.UTC(2026, 0, 15, h - 2, m, s));

describe('findNextAvailableSlot, notBefore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(kyiv(10, 5));
    latestPending.mockResolvedValue(null);
  });
  afterEach(() => vi.useRealTimers());

  it('takes the next slot after now without one', async () => {
    expect(await findNextAvailableSlot('-100')).toEqual(kyiv(10, 30, 1));
  });

  // A separated reply in an empty channel goes out with or after its parent, never before.
  it('takes the parent slot itself, not one before it', async () => {
    expect(await findNextAvailableSlot('-100', kyiv(14, 0, 1))).toEqual(kyiv(14, 0, 1));
  });

  it('ignores a notBefore already past', async () => {
    expect(await findNextAvailableSlot('-100', kyiv(9, 0, 1))).toEqual(kyiv(10, 30, 1));
  });

  it('still queues after the channel’s latest post', async () => {
    latestPending.mockResolvedValue({ scheduledTime: kyiv(16, 0, 1) });
    expect(await findNextAvailableSlot('-100', kyiv(14, 0, 1))).toEqual(kyiv(16, 30, 1));
  });
});
