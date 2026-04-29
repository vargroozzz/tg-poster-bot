import { describe, it, expect } from 'vitest';
import { computeRepackSlots } from '../queue-repack.service.js';
import type { SleepWindow } from '../../../utils/sleep-window.js';

// 2026-01-15, Kyiv = UTC+2 in January
function kyivDate(timeStr: string): Date {
  const [h, m, s] = timeStr.split(':').map(Number);
  return new Date(Date.UTC(2026, 0, 15, h - 2, m, s));
}

describe('computeRepackSlots', () => {
  it('returns empty array for count 0', () => {
    expect(computeRepackSlots(0, kyivDate('14:00:01'), 15, null)).toEqual([]);
  });

  it('returns single-element array for count 1', () => {
    expect(computeRepackSlots(1, kyivDate('14:00:01'), 15, null)).toEqual([
      kyivDate('14:00:01'),
    ]);
  });

  it('builds consecutive 15-min slots without sleep window', () => {
    const result = computeRepackSlots(3, kyivDate('14:00:01'), 15, null);
    expect(result).toEqual([
      kyivDate('14:00:01'),
      kyivDate('14:15:01'),
      kyivDate('14:30:01'),
    ]);
  });

  it('builds consecutive 30-min slots without sleep window', () => {
    const result = computeRepackSlots(3, kyivDate('14:00:01'), 30, null);
    expect(result).toEqual([
      kyivDate('14:00:01'),
      kyivDate('14:30:01'),
      kyivDate('15:00:01'),
    ]);
  });

  it('skips sleep window between slots', () => {
    // sleep window: 01:00–09:00 Kyiv (exclusive boundaries)
    // 00:30:01 + 30min = 01:00:01 — boundary, not inside → kept
    // 01:00:01 + 30min = 01:30:01 — inside (1,9) → skipped to 09:00:01
    const sleepWindow: SleepWindow = { startHour: 1, endHour: 9 };
    const result = computeRepackSlots(3, kyivDate('00:30:01'), 30, sleepWindow);
    expect(result).toEqual([
      kyivDate('00:30:01'),
      kyivDate('01:00:01'),
      kyivDate('09:00:01'),
    ]);
  });
});
