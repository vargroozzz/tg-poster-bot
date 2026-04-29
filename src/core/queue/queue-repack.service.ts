import { addMinutes } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { ScheduledPost } from '../../database/models/scheduled-post.model.js';
import { ScheduledPostRepository } from '../../database/repositories/scheduled-post.repository.js';
import { getPostInterval } from '../../utils/post-interval.js';
import { getSleepWindow, skipSleepWindow, type SleepWindow } from '../../utils/sleep-window.js';
import { calculateNextSlotForInterval } from '../../utils/time-slots.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

const TIMEZONE = config.timezone;

/**
 * Compute a sequence of `count` consecutive slot times starting at `firstSlot`,
 * each separated by `intervalMinutes`, respecting the sleep window.
 * Pure function — exported for unit testing.
 */
export function computeRepackSlots(
  count: number,
  firstSlot: Date,
  intervalMinutes: number,
  sleepWindow: SleepWindow | null
): Date[] {
  const slots: Date[] = [];
  let current = firstSlot;
  for (let i = 0; i < count; i++) {
    slots.push(current);
    const candidate = addMinutes(current, intervalMinutes);
    current = sleepWindow ? skipSleepWindow(candidate, sleepWindow) : candidate;
  }
  return slots;
}

export class QueueRepackService {
  private repository = new ScheduledPostRepository();

  async repackAll(): Promise<{ totalPosts: number; channelCount: number }> {
    const [intervalMinutes, sleepWindow] = await Promise.all([
      getPostInterval(),
      getSleepWindow(),
    ]);

    const channelIds = (await ScheduledPost.distinct('targetChannelId', {
      status: 'pending',
    })) as string[];

    const counts = await Promise.all(
      channelIds.map((channelId) => this.repackChannel(channelId, intervalMinutes, sleepWindow))
    );
    const totalPosts = counts.reduce((sum, n) => sum + n, 0);

    return { totalPosts, channelCount: channelIds.length };
  }

  private async repackChannel(
    channelId: string,
    intervalMinutes: number,
    sleepWindow: SleepWindow | null
  ): Promise<number> {
    const posts = await this.repository.findPendingByChannel(channelId);
    if (posts.length === 0) return 0;

    // Compute first slot from scratch rather than using findNextAvailableSlot,
    // because that function advances past the latest pending post — repack ignores
    // the existing schedule and starts fresh from now.
    const nowInTz = toZonedTime(new Date(), TIMEZONE);
    const firstSlotInTz = calculateNextSlotForInterval(nowInTz, intervalMinutes);
    const firstSlotUtc = fromZonedTime(firstSlotInTz, TIMEZONE);
    const firstSlot = sleepWindow ? skipSleepWindow(firstSlotUtc, sleepWindow) : firstSlotUtc;

    const newTimes = computeRepackSlots(posts.length, firstSlot, intervalMinutes, sleepWindow);

    // Update order avoids unique-index conflicts on (scheduledTime, targetChannelId):
    // expanding (new end > old end) → last-to-first
    // compressing or same end → first-to-last
    const expanding = newTimes[newTimes.length - 1] > posts[posts.length - 1].scheduledTime;
    const indices = Array.from({ length: posts.length }, (_, i) => i);
    const orderedIndices = expanding ? [...indices].reverse() : indices;

    for (const i of orderedIndices) {
      await posts[i].updateOne({ $set: { scheduledTime: newTimes[i] } });
    }

    logger.info(
      `Repacked ${posts.length} posts for channel ${channelId} to ${intervalMinutes}-min intervals`
    );
    return posts.length;
  }
}
