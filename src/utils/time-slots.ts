import { addMinutes, setMinutes, setSeconds, setMilliseconds } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { ScheduledPost } from '../database/models/scheduled-post.model.js';
import { config } from '../config/index.js';
import { logger } from './logger.js';
import { getSleepWindow, skipSleepWindow } from './sleep-window.js';
import { getPostInterval } from './post-interval.js';

const TIMEZONE = config.timezone;

/**
 * Find the next available time slot in Europe/Kyiv timezone.
 * Returns UTC Date.
 */
export async function findNextAvailableSlot(targetChannelId: string): Promise<Date> {
  const [sleepWindow, intervalMinutes] = await Promise.all([
    getSleepWindow(),
    getPostInterval(),
  ]);

  const rawNextSlot = fromZonedTime(
    calculateNextSlotForInterval(toZonedTime(new Date(), TIMEZONE), intervalMinutes),
    TIMEZONE
  );
  const nextSlotAfterNow = sleepWindow ? skipSleepWindow(rawNextSlot, sleepWindow) : rawNextSlot;

  const latestPending = await ScheduledPost
    .findOne({ targetChannelId, status: 'pending' })
    .sort({ scheduledTime: -1 });

  if (latestPending && latestPending.scheduledTime >= nextSlotAfterNow) {
    const candidate = addMinutes(latestPending.scheduledTime, intervalMinutes);
    const slot = sleepWindow ? skipSleepWindow(candidate, sleepWindow) : candidate;
    logger.debug(`Found available slot: ${slot.toISOString()} (after latest pending)`);
    return slot;
  }

  logger.debug(`Found available slot: ${nextSlotAfterNow.toISOString()} (next slot after now)`);
  return nextSlotAfterNow;
}

/**
 * Calculate the next slot aligned to `intervalMinutes` from the top of the hour.
 * `now` must be in the display timezone (i.e. already converted via toZonedTime).
 * Exported for unit testing.
 */
export function calculateNextSlotForInterval(now: Date, intervalMinutes: number): Date {
  const minutes = now.getMinutes();
  const nextSlotMinutes = (Math.floor(minutes / intervalMinutes) + 1) * intervalMinutes;

  const baseSlot = nextSlotMinutes >= 60
    ? setMinutes(addMinutes(now, 60 - minutes), 0)
    : setMinutes(now, nextSlotMinutes);

  const slot = setMilliseconds(setSeconds(baseSlot, 1), 0);
  return slot <= now ? addMinutes(slot, intervalMinutes) : slot;
}

/**
 * Format a UTC Date as a human-readable string in Europe/Kyiv timezone.
 */
export function formatSlotTime(utcDate: Date): string {
  const tzDate = toZonedTime(utcDate, TIMEZONE);
  return tzDate.toLocaleString('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
