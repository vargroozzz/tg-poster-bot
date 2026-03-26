import { setHours, setMinutes, setSeconds, setMilliseconds } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { BotSettings } from '../database/models/bot-settings.model.js';

const TIMEZONE = 'Europe/Kyiv';

export interface SleepWindow {
  startHour: number;
  endHour: number;
}

/**
 * Read sleep window from DB. Returns null if disabled or not configured.
 * Callers treat null as "no window active" and skip skipSleepWindow entirely.
 */
export async function getSleepWindow(): Promise<SleepWindow | null> {
  const settings = await BotSettings.find({
    key: { $in: ['sleep_enabled', 'sleep_start', 'sleep_end'] },
  });

  const map = new Map(settings.map((s) => [s.key, s.value]));

  if (map.get('sleep_enabled') !== 'true') return null;

  const startHour = parseInt(map.get('sleep_start') ?? '1', 10);
  const endHour = parseInt(map.get('sleep_end') ?? '9', 10);

  if (isNaN(startHour) || isNaN(endHour)) return null;

  return { startHour, endHour };
}

/**
 * If slot falls inside [startHour, endHour) in Kyiv timezone, advance it to
 * endHour:00:01 of the same day. Otherwise return slot unchanged.
 * Pure function — no DB access.
 * Note: midnight-crossing windows (startHour > endHour) are not supported and will not skip correctly.
 */
export function skipSleepWindow(slot: Date, sleepWindow: SleepWindow): Date {
  const kyivDate = toZonedTime(slot, TIMEZONE);
  const hour = kyivDate.getHours();

  if (hour >= sleepWindow.startHour && hour < sleepWindow.endHour) {
    const wakeSlot = setMilliseconds(
      setSeconds(setMinutes(setHours(kyivDate, sleepWindow.endHour), 0), 1),
      0
    );
    return fromZonedTime(wakeSlot, TIMEZONE);
  }

  return slot;
}
