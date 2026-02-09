import { addMinutes, setSeconds, setMilliseconds } from 'date-fns';
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
  // Get current time in target timezone
  const nowUtc = new Date();
  const nowInTz = toZonedTime(nowUtc, TIMEZONE);

  // Calculate next slot time in target timezone
  let nextSlot = calculateNextSlot(nowInTz);

  // Keep trying slots until we find one that's not occupied
  let attempts = 0;
  const maxAttempts = 48; // Check up to 24 hours ahead

  while (attempts < maxAttempts) {
    // Convert slot time back to UTC for database query
    const slotUtc = fromZonedTime(nextSlot, TIMEZONE);

    // Check if this slot is already occupied
    const existingPost = await ScheduledPost.findOne({
      scheduledTime: slotUtc,
      targetChannelId,
    });

    if (!existingPost) {
      logger.debug(`Found available slot: ${nextSlot.toISOString()} (${TIMEZONE})`);
      return slotUtc;
    }

    logger.debug(`Slot ${nextSlot.toISOString()} is occupied, trying next slot`);

    // Try next slot (30 minutes later)
    nextSlot = addMinutes(nextSlot, 30);
    attempts++;
  }

  // If we couldn't find a slot in 24 hours, something is wrong
  throw new Error('Could not find available time slot within 24 hours');
}

/**
 * Calculate the next hh:00:01 or hh:30:01 slot from the given time
 */
function calculateNextSlot(now: Date): Date {
  const minutes = now.getMinutes();

  let nextSlot: Date;

  if (minutes < 30) {
    // Next slot is at hh:30:01
    nextSlot = new Date(now);
    nextSlot.setMinutes(30);
  } else {
    // Next slot is at (hh+1):00:01
    nextSlot = addMinutes(now, 60 - minutes);
    nextSlot.setMinutes(0);
  }

  // Set seconds to 01 and milliseconds to 0
  nextSlot = setSeconds(nextSlot, 1);
  nextSlot = setMilliseconds(nextSlot, 0);

  // If we're already past the calculated slot (e.g., current time is 14:30:05), move to next slot
  if (nextSlot <= now) {
    nextSlot = addMinutes(nextSlot, 30);
  }

  return nextSlot;
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
