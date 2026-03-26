import { describe, it, expect } from 'vitest';
import { skipSleepWindow } from '../sleep-window.js';
import type { SleepWindow } from '../sleep-window.js';

const WINDOW: SleepWindow = { startHour: 1, endHour: 9 };

// Helper: make a UTC Date that corresponds to a given Kyiv local time.
// Europe/Kyiv is UTC+2 (standard) or UTC+3 (DST). Use a known DST-off date (January).
// 2026-01-15 03:00 Kyiv = 2026-01-15 01:00 UTC
function kyivUTC(isoLocal: string): Date {
  // January dates → UTC+2. Subtract 2 hours.
  const [datePart, timePart] = isoLocal.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, m, s] = timePart.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 2, m, s));
}

describe('skipSleepWindow', () => {
  it('returns slot unchanged when outside sleep window', () => {
    // 10:00:01 Kyiv — after window end (9)
    const slot = kyivUTC('2026-01-15T10:00:01');
    expect(skipSleepWindow(slot, WINDOW)).toEqual(slot);
  });

  it('advances slot to 09:00:01 Kyiv when inside window (hour 3)', () => {
    // 03:00:01 Kyiv — inside [1, 9)
    const slot = kyivUTC('2026-01-15T03:00:01');
    const result = skipSleepWindow(slot, WINDOW);
    // Expected: 09:00:01 Kyiv = 07:00:01 UTC on same day
    expect(result).toEqual(kyivUTC('2026-01-15T09:00:01'));
  });

  it('advances slot at exactly startHour (1:00) to endHour (9:00)', () => {
    const slot = kyivUTC('2026-01-15T01:00:01');
    const result = skipSleepWindow(slot, WINDOW);
    expect(result).toEqual(kyivUTC('2026-01-15T09:00:01'));
  });

  it('returns slot unchanged at exactly endHour (9:00) — boundary is exclusive', () => {
    const slot = kyivUTC('2026-01-15T09:00:01');
    expect(skipSleepWindow(slot, WINDOW)).toEqual(slot);
  });

  it('returns slot unchanged at midnight (hour 0) — before window', () => {
    const slot = kyivUTC('2026-01-15T00:00:01');
    expect(skipSleepWindow(slot, WINDOW)).toEqual(slot);
  });
});
