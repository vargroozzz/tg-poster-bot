import { describe, it, expect } from 'vitest';

function kyivDate(timeStr: string): Date {
  const [h, m, s] = timeStr.split(':').map(Number);
  // Kyiv=UTC+2 in January: subtract 2h to get UTC
  return new Date(Date.UTC(2026, 0, 15, h - 2, m, s));
}

import { calculateNextSlotForInterval } from '../time-slots.js';

describe('calculateNextSlotForInterval', () => {
  describe('30-minute interval (legacy behaviour)', () => {
    it('at 14:01 → next slot is 14:30:01', () => {
      const result = calculateNextSlotForInterval(kyivDate('14:01:00'), 30);
      expect(result).toEqual(kyivDate('14:30:01'));
    });

    it('at 14:29 → next slot is 14:30:01', () => {
      const result = calculateNextSlotForInterval(kyivDate('14:29:00'), 30);
      expect(result).toEqual(kyivDate('14:30:01'));
    });

    it('at 14:31 → next slot is 15:00:01', () => {
      const result = calculateNextSlotForInterval(kyivDate('14:31:00'), 30);
      expect(result).toEqual(kyivDate('15:00:01'));
    });

    it('at 14:30:01 (already on slot) → next slot is 15:00:01', () => {
      const result = calculateNextSlotForInterval(kyivDate('14:30:01'), 30);
      expect(result).toEqual(kyivDate('15:00:01'));
    });

    it('at 23:45 → next slot is 00:00:01 next day', () => {
      const result = calculateNextSlotForInterval(kyivDate('23:45:00'), 30);
      expect(result).toEqual(new Date(Date.UTC(2026, 0, 15, 22, 0, 1)));
    });
  });

  describe('15-minute interval', () => {
    it('at 14:00:01 (already on slot) → next slot is 14:15:01', () => {
      const result = calculateNextSlotForInterval(kyivDate('14:00:01'), 15);
      expect(result).toEqual(kyivDate('14:15:01'));
    });

    it('at 14:01 → next slot is 14:15:01', () => {
      const result = calculateNextSlotForInterval(kyivDate('14:01:00'), 15);
      expect(result).toEqual(kyivDate('14:15:01'));
    });

    it('at 14:14 → next slot is 14:15:01', () => {
      const result = calculateNextSlotForInterval(kyivDate('14:14:00'), 15);
      expect(result).toEqual(kyivDate('14:15:01'));
    });

    it('at 14:16 → next slot is 14:30:01', () => {
      const result = calculateNextSlotForInterval(kyivDate('14:16:00'), 15);
      expect(result).toEqual(kyivDate('14:30:01'));
    });

    it('at 14:46 → next slot is 15:00:01', () => {
      const result = calculateNextSlotForInterval(kyivDate('14:46:00'), 15);
      expect(result).toEqual(kyivDate('15:00:01'));
    });
  });

  describe('60-minute interval', () => {
    it('at 14:01 → next slot is 15:00:01', () => {
      const result = calculateNextSlotForInterval(kyivDate('14:01:00'), 60);
      expect(result).toEqual(kyivDate('15:00:01'));
    });

    it('at 14:00:01 (already on slot) → next slot is 15:00:01', () => {
      const result = calculateNextSlotForInterval(kyivDate('14:00:01'), 60);
      expect(result).toEqual(kyivDate('15:00:01'));
    });
  });
});
