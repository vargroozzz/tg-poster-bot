# Configurable Post Interval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded 30-minute post interval with a configurable value stored in `BotSettings`, defaulting to 30 for backwards compatibility, with a `/interval` command to change it.

**Architecture:** A new `getPostInterval()` helper reads `post_interval` from MongoDB `BotSettings`. `calculateNextSlot` and `findNextAvailableSlot` in `time-slots.ts` are generalized to accept/read the interval dynamically. A `/interval` command with inline keyboard (15 / 30 / 60 min) lets the user change it in one tap.

**Tech Stack:** TypeScript, Grammy, Mongoose/MongoDB, Vitest, date-fns, date-fns-tz

---

### Task 1: Add `getPostInterval()` helper

**Files:**
- Create: `src/utils/post-interval.ts`

- [ ] **Step 1: Create the helper**

```typescript
// src/utils/post-interval.ts
import { BotSettings } from '../database/models/bot-settings.model.js';

export const VALID_INTERVALS = [15, 30, 60] as const;
export type PostInterval = (typeof VALID_INTERVALS)[number];

export async function getPostInterval(): Promise<number> {
  const setting = await BotSettings.findOne({ key: 'post_interval' });
  const parsed = parseInt(setting?.value ?? '30', 10);
  return VALID_INTERVALS.includes(parsed as PostInterval) ? parsed : 30;
}

export async function setPostInterval(minutes: PostInterval): Promise<void> {
  await BotSettings.findOneAndUpdate(
    { key: 'post_interval' },
    { key: 'post_interval', value: String(minutes), updatedAt: new Date() },
    { upsert: true }
  );
}
```

- [ ] **Step 2: Verify build passes**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/post-interval.ts
git commit -m "feat: add getPostInterval/setPostInterval helpers"
```

---

### Task 2: Generalize time-slot calculation

**Files:**
- Modify: `src/utils/time-slots.ts`
- Create: `src/utils/__tests__/time-slots.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/utils/__tests__/time-slots.test.ts
import { describe, it, expect } from 'vitest';

// We test the internal calculateNextSlot by re-exporting it for tests.
// Since it's not currently exported, we'll test via the exported shape after refactor.
// For now write tests against the expected slot outputs.

// Helper: build a local Date in Europe/Kyiv for a fixed UTC offset date.
// 2026-01-15 (January, UTC+2). kyivLocal('14:29:00') → Date where Kyiv time is 14:29:00.
function kyivDate(timeStr: string): Date {
  const [h, m, s] = timeStr.split(':').map(Number);
  // Kyiv=UTC+2 in January: subtract 2h to get UTC
  return new Date(Date.UTC(2026, 0, 15, h - 2, m, s));
}

// Import the function under test — we'll export it in the next step.
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
      // 00:00:01 Kyiv next day = 2026-01-15T22:00:01Z (UTC+2 in Jan)
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/utils/__tests__/time-slots.test.ts
```

Expected: FAIL — `calculateNextSlotForInterval` is not exported.

- [ ] **Step 3: Refactor `time-slots.ts`**

Replace the entire file content:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/utils/__tests__/time-slots.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Verify build still passes**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/utils/time-slots.ts src/utils/__tests__/time-slots.test.ts
git commit -m "feat: generalize slot calculation to support configurable interval"
```

---

### Task 3: Add interval selection keyboard

**Files:**
- Create: `src/bot/keyboards/interval.keyboard.ts`

- [ ] **Step 1: Create the keyboard**

```typescript
// src/bot/keyboards/interval.keyboard.ts
import { InlineKeyboard } from 'grammy';
import { VALID_INTERVALS, type PostInterval } from '../../utils/post-interval.js';

export function createIntervalKeyboard(currentInterval: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const minutes of VALID_INTERVALS) {
    const label = currentInterval === minutes ? `✓ ${minutes} min` : `${minutes} min`;
    keyboard.text(label, `interval:set:${minutes}`);
  }
  return keyboard;
}
```

- [ ] **Step 2: Verify build passes**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/bot/keyboards/interval.keyboard.ts
git commit -m "feat: add interval selection keyboard"
```

---

### Task 4: Add `/interval` command

**Files:**
- Modify: `src/bot/handlers/command.handler.ts`

- [ ] **Step 1: Add import at top of file**

In `src/bot/handlers/command.handler.ts`, add to the existing imports:

```typescript
import { getPostInterval } from '../../utils/post-interval.js';
import { createIntervalKeyboard } from '../keyboards/interval.keyboard.js';
```

- [ ] **Step 2: Add the command handler**

Append at the end of `src/bot/handlers/command.handler.ts` (before any trailing exports if present, otherwise at the very end):

```typescript
bot.command('interval', async (ctx: Context) => {
  try {
    const current = await getPostInterval();
    await ctx.reply(
      `Post interval: every ${current} minutes\n\nSelect a new interval:`,
      { reply_markup: createIntervalKeyboard(current) }
    );
  } catch (error) {
    logger.error('Error in /interval command:', error);
    await ctx.reply('Error loading interval settings. Please try again.');
  }
});
```

- [ ] **Step 3: Verify build passes**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot/handlers/command.handler.ts
git commit -m "feat: add /interval command"
```

---

### Task 5: Add `interval:set:*` callback handlers

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`

- [ ] **Step 1: Add imports**

In `src/bot/handlers/callback.handler.ts`, add to the existing imports:

```typescript
import { getPostInterval, setPostInterval, VALID_INTERVALS, type PostInterval } from '../../utils/post-interval.js';
import { createIntervalKeyboard } from '../keyboards/interval.keyboard.js';
```

- [ ] **Step 2: Add callback handler**

Append near the end of `src/bot/handlers/callback.handler.ts` (after the sleep callbacks section, before the final closing):

```typescript
// ──────────────────────────────────────────────
// Post interval configuration callbacks
// ──────────────────────────────────────────────

bot.callbackQuery(/^interval:set:(\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const match = ctx.callbackQuery?.data?.match(/^interval:set:(\d+)$/);
    const minutes = parseInt(match?.[1] ?? '30', 10);

    if (!VALID_INTERVALS.includes(minutes as PostInterval)) {
      await ctx.answerCallbackQuery('Invalid interval.');
      return;
    }

    await setPostInterval(minutes as PostInterval);

    await ctx.editMessageText(
      `Post interval: every ${minutes} minutes ✅`,
      { reply_markup: createIntervalKeyboard(minutes) }
    );
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error saving interval. Please try again.',
      'interval:set callback'
    );
  }
});
```

- [ ] **Step 3: Verify build passes**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot/handlers/callback.handler.ts
git commit -m "feat: add interval:set callback handler"
```

---

### Task 6: Register `/interval` command hint

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add to command hints list**

In `src/index.ts`, add `/interval` to the `setMyCommands` array after the `/sleep` entry:

```typescript
{ command: 'sleep', description: 'Configure sleep hours (no posts during window)' },
{ command: 'interval', description: 'Set post interval (15 / 30 / 60 min)' },
```

- [ ] **Step 2: Final build check**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass including the new `time-slots.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: register /interval command hint"
```

---

### Task 7: Push to remote

- [ ] **Step 1: Push**

```bash
git push
```

Expected: branch pushed, Render auto-deploy triggered.
