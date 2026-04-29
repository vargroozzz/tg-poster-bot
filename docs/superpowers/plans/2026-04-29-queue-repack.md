# Queue Repack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Reschedule queue" button to the interval confirmation message that repacks all pending posts to consecutive slots at the active interval.

**Architecture:** A new `QueueRepackService` in `src/core/queue/` handles all repack logic. A pure `computeRepackSlots` function (exported for testing) computes new slot times without DB access. The keyboard gains an optional `showRepack` row, shown only in the post-set confirmation. A new `interval:repack` callback triggers the repack and edits the message with a result summary.

**Tech Stack:** TypeScript, Grammy, Mongoose/MongoDB, Vitest, date-fns, date-fns-tz

---

### Task 1: `QueueRepackService` with pure slot computation and tests

**Files:**
- Create: `src/core/queue/queue-repack.service.ts`
- Create: `src/core/queue/__tests__/queue-repack.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/queue/__tests__/queue-repack.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npx vitest run src/core/queue/__tests__/queue-repack.test.ts
```

Expected: FAIL — `computeRepackSlots` not found.

- [ ] **Step 3: Create `queue-repack.service.ts`**

```typescript
// src/core/queue/queue-repack.service.ts
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

    let totalPosts = 0;
    for (const channelId of channelIds) {
      totalPosts += await this.repackChannel(channelId, intervalMinutes, sleepWindow);
    }

    return { totalPosts, channelCount: channelIds.length };
  }

  private async repackChannel(
    channelId: string,
    intervalMinutes: number,
    sleepWindow: SleepWindow | null
  ): Promise<number> {
    const posts = await this.repository.findPendingByChannel(channelId);
    if (posts.length === 0) return 0;

    const nowInTz = toZonedTime(new Date(), TIMEZONE);
    const firstSlotInTz = calculateNextSlotForInterval(nowInTz, intervalMinutes);
    const firstSlotUtc = fromZonedTime(firstSlotInTz, TIMEZONE);
    const firstSlot = sleepWindow ? skipSleepWindow(firstSlotUtc, sleepWindow) : firstSlotUtc;

    const newTimes = computeRepackSlots(posts.length, firstSlot, intervalMinutes, sleepWindow);

    // Update order avoids unique-index conflicts on (scheduledTime, targetChannelId):
    // expanding (new start > old start) → last-to-first
    // compressing or same start → first-to-last
    const expanding = newTimes[0] > posts[0].scheduledTime;
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npx vitest run src/core/queue/__tests__/queue-repack.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Verify build**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && git add src/core/queue/queue-repack.service.ts src/core/queue/__tests__/queue-repack.test.ts && git commit -m "feat: add QueueRepackService with computeRepackSlots"
```

---

### Task 2: Update `createIntervalKeyboard` to support repack button

**Files:**
- Modify: `src/bot/keyboards/interval.keyboard.ts`

- [ ] **Step 1: Replace the file content**

```typescript
// src/bot/keyboards/interval.keyboard.ts
import { InlineKeyboard } from 'grammy';
import { VALID_INTERVALS, type PostInterval } from '../../utils/post-interval.js';

export function createIntervalKeyboard(
  currentInterval: PostInterval,
  showRepack = false
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const minutes of VALID_INTERVALS) {
    const label = currentInterval === minutes ? `✓ ${minutes} min` : `${minutes} min`;
    keyboard.text(label, `interval:set:${minutes}`);
  }
  if (showRepack) {
    keyboard.row().text(
      `Reschedule queue to ${currentInterval} min intervals`,
      'interval:repack'
    );
  }
  return keyboard;
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no TypeScript errors. (The `/interval` command handler calls `createIntervalKeyboard(current)` — `showRepack` defaults to `false`, so no change needed there.)

- [ ] **Step 3: Commit**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && git add src/bot/keyboards/interval.keyboard.ts && git commit -m "feat: add optional repack row to interval keyboard"
```

---

### Task 3: Wire up callbacks

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`

- [ ] **Step 1: Add import**

In `src/bot/handlers/callback.handler.ts`, add to the existing imports:

```typescript
import { QueueRepackService } from '../../core/queue/queue-repack.service.js';
```

- [ ] **Step 2: Update `interval:set:*` to show the repack button**

Find the `interval:set:*` callback handler. The current `editMessageText` call is:

```typescript
await ctx.editMessageText(
  `Post interval: every ${minutes} minutes ✅`,
  { reply_markup: createIntervalKeyboard(minutes) }
);
```

Change it to pass `true` for `showRepack`:

```typescript
await ctx.editMessageText(
  `Post interval: every ${minutes} minutes ✅`,
  { reply_markup: createIntervalKeyboard(minutes, true) }
);
```

- [ ] **Step 3: Add `interval:repack` callback**

Append after the `interval:set:*` handler (at the very end of the file):

```typescript
bot.callbackQuery('interval:repack', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const repackService = new QueueRepackService();
    const { totalPosts, channelCount } = await repackService.repackAll();

    const text =
      totalPosts === 0
        ? 'No pending posts to reschedule.'
        : `Queue repacked ✅\n${totalPosts} post${totalPosts === 1 ? '' : 's'} across ${channelCount} channel${channelCount === 1 ? '' : 's'} rescheduled.`;

    await ctx.editMessageText(text);
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error repacking queue. Please try again.',
      'interval:repack callback'
    );
  }
});
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npx vitest run
```

Expected: all tests pass (now 34 total: 29 previous + 5 new).

- [ ] **Step 6: Commit**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && git add src/bot/handlers/callback.handler.ts && git commit -m "feat: add interval:repack callback and show repack button after interval change"
```

---

### Task 4: Push to remote

- [ ] **Step 1: Push**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && git push
```

Expected: branch pushed, Render auto-deploy triggered.
