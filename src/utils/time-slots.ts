import { addMinutes, setMinutes, setSeconds, setMilliseconds } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { ScheduledPost } from '../database/models/scheduled-post.model.js';
import { config } from '../config/index.js';
import { logger } from './logger.js';

const TIMEZONE = config.timezone;

/**
 * Find the next available time slot in Europe/Kyiv timezone
 * Slots are at hh:00:01 or hh:30:01
 * Returns UTC Date object
 */
export async function findNextAvailableSlot(targetChannelId: string): Promise<Date> {
  const nextSlotAfterNow = fromZonedTime(
    calculateNextSlot(toZonedTime(new Date(), TIMEZONE)),
    TIMEZONE
  );

  const latestPending = await ScheduledPost
    .findOne({ targetChannelId, status: 'pending' })
    .sort({ scheduledTime: -1 });

  if (latestPending && latestPending.scheduledTime >= nextSlotAfterNow) {
    const slot = addMinutes(latestPending.scheduledTime, 30);
    logger.debug(`Found available slot: ${slot.toISOString()} (after latest pending)`);
    return slot;
  }

  logger.debug(`Found available slot: ${nextSlotAfterNow.toISOString()} (next slot after now)`);
  return nextSlotAfterNow;
}

/**
 * Calculate the next hh:00:01 or hh:30:01 slot from the given time
 */
function calculateNextSlot(now: Date): Date {
  const minutes = now.getMinutes();

  const baseSlot = minutes < 30
    ? setMinutes(now, 30)                           // hh:30:01
    : setMinutes(addMinutes(now, 60 - minutes), 0); // (hh+1):00:01

  const slot = setMilliseconds(setSeconds(baseSlot, 1), 0);

  // If we're already past the calculated slot (e.g., current time is 14:30:05), move to next slot
  return slot <= now ? addMinutes(slot, 30) : slot;
}

/**
 * Format a UTC Date as a human-readable string in Europe/Kyiv timezone
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
