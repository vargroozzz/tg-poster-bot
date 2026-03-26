# Sleep Hours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable sleep window (default 01:00–09:00 Kyiv time) during which no posts are scheduled — posts that would land in the window are pushed to the first slot after it ends. Configured via `/sleep` bot command with an inline keyboard UI.

**Architecture:** Three `BotSettings` keys (`sleep_enabled`, `sleep_start`, `sleep_end`) store the config. A new `src/utils/sleep-window.ts` provides `getSleepWindow()` (DB read) and `skipSleepWindow()` (pure function). `findNextAvailableSlot` in `time-slots.ts` calls these two functions. The bot UI lives in a new keyboard file + `/sleep` command + `sleep:*` callbacks.

**Tech Stack:** TypeScript, grammy, mongoose, date-fns / date-fns-tz, vitest

---

### Task 1: `src/utils/sleep-window.ts` — core logic

**Files:**
- Create: `src/utils/sleep-window.ts`
- Create: `src/utils/__tests__/sleep-window.test.ts`

- [ ] **Step 1: Write failing tests for `skipSleepWindow`**

Create `src/utils/__tests__/sleep-window.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npx vitest run src/utils/__tests__/sleep-window.test.ts
```

Expected: error — `sleep-window.js` module not found.

- [ ] **Step 3: Create `src/utils/sleep-window.ts`**

```typescript
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
 */
export async function getSleepWindow(): Promise<SleepWindow | null> {
  const settings = await BotSettings.find({
    key: { $in: ['sleep_enabled', 'sleep_start', 'sleep_end'] },
  });

  const map = new Map(settings.map((s) => [s.key, s.value]));

  if (map.get('sleep_enabled') !== 'true') return null;

  const startHour = parseInt(map.get('sleep_start') ?? '1', 10);
  const endHour = parseInt(map.get('sleep_end') ?? '9', 10);

  return { startHour, endHour };
}

/**
 * If slot falls inside [startHour, endHour) in Kyiv timezone, advance it to
 * endHour:00:01 of the same day. Otherwise return slot unchanged.
 * Pure function — no DB access.
 */
export function skipSleepWindow(slot: Date, window: SleepWindow): Date {
  const kyivDate = toZonedTime(slot, TIMEZONE);
  const hour = kyivDate.getHours();

  if (hour >= window.startHour && hour < window.endHour) {
    const wakeSlot = setMilliseconds(
      setSeconds(setMinutes(setHours(kyivDate, window.endHour), 0), 1),
      0
    );
    return fromZonedTime(wakeSlot, TIMEZONE);
  }

  return slot;
}
```

- [ ] **Step 4: Run tests — expect all 5 to pass**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npx vitest run src/utils/__tests__/sleep-window.test.ts
```

Expected output:
```
✓ src/utils/__tests__/sleep-window.test.ts (5)
  ✓ skipSleepWindow > returns slot unchanged when outside sleep window
  ✓ skipSleepWindow > advances slot to 09:00:01 Kyiv when inside window (hour 3)
  ✓ skipSleepWindow > advances slot at exactly startHour (1:00) to endHour (9:00)
  ✓ skipSleepWindow > returns slot unchanged at exactly endHour (9:00) — boundary is exclusive
  ✓ skipSleepWindow > returns slot unchanged at midnight (hour 0) — before window
Test Files  1 passed (1)
```

- [ ] **Step 5: Verify build**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/utils/sleep-window.ts src/utils/__tests__/sleep-window.test.ts
git commit -m "feat: add sleep window utility with getSleepWindow and skipSleepWindow"
```

---

### Task 2: Wire sleep window into slot calculation

**Files:**
- Modify: `src/utils/time-slots.ts`

Current `findNextAvailableSlot` (lines 14–32):
```typescript
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
```

- [ ] **Step 1: Add import and update `findNextAvailableSlot`**

Add the import at the top of `src/utils/time-slots.ts` (after existing imports):

```typescript
import { getSleepWindow, skipSleepWindow } from './sleep-window.js';
```

Replace the `findNextAvailableSlot` function body (the entire function, lines 14–32):

```typescript
export async function findNextAvailableSlot(targetChannelId: string): Promise<Date> {
  const sleepWindow = await getSleepWindow();

  const rawNextSlot = fromZonedTime(
    calculateNextSlot(toZonedTime(new Date(), TIMEZONE)),
    TIMEZONE
  );
  const nextSlotAfterNow = sleepWindow ? skipSleepWindow(rawNextSlot, sleepWindow) : rawNextSlot;

  const latestPending = await ScheduledPost
    .findOne({ targetChannelId, status: 'pending' })
    .sort({ scheduledTime: -1 });

  if (latestPending && latestPending.scheduledTime >= nextSlotAfterNow) {
    const candidate = addMinutes(latestPending.scheduledTime, 30);
    const slot = sleepWindow ? skipSleepWindow(candidate, sleepWindow) : candidate;
    logger.debug(`Found available slot: ${slot.toISOString()} (after latest pending)`);
    return slot;
  }

  logger.debug(`Found available slot: ${nextSlotAfterNow.toISOString()} (next slot after now)`);
  return nextSlotAfterNow;
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/time-slots.ts
git commit -m "feat: skip sleep window in findNextAvailableSlot"
```

---

### Task 3: Sleep keyboard

**Files:**
- Create: `src/bot/keyboards/sleep.keyboard.ts`

- [ ] **Step 1: Create `src/bot/keyboards/sleep.keyboard.ts`**

```typescript
import { InlineKeyboard } from 'grammy';

export function createSleepStatusKeyboard(enabled: boolean): InlineKeyboard {
  if (enabled) {
    return new InlineKeyboard()
      .text('Change hours', 'sleep:change')
      .text('Disable', 'sleep:disable');
  }
  return new InlineKeyboard().text('Enable', 'sleep:enable');
}

export function createHourPickerKeyboard(phase: 'start'): InlineKeyboard;
export function createHourPickerKeyboard(phase: 'end', startHour: number): InlineKeyboard;
export function createHourPickerKeyboard(
  phase: 'start' | 'end',
  startHour?: number
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let h = 0; h < 24; h++) {
    const label = h.toString().padStart(2, '0');
    const data =
      phase === 'start' ? `sleep:start:${h}` : `sleep:end:${startHour}:${h}`;
    keyboard.text(label, data);
    if ((h + 1) % 6 === 0) keyboard.row();
  }
  return keyboard;
}

export function createSleepConfirmKeyboard(start: number, end: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('Confirm', `sleep:confirm:${start}:${end}`)
    .text('Cancel', 'sleep:cancel');
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/bot/keyboards/sleep.keyboard.ts
git commit -m "feat: add sleep hour picker and status keyboards"
```

---

### Task 4: `/sleep` command

**Files:**
- Modify: `src/bot/handlers/command.handler.ts`

- [ ] **Step 1: Add imports to `command.handler.ts`**

At the top of the imports block, add:

```typescript
import { getSleepWindow } from '../../utils/sleep-window.js';
import {
  createSleepStatusKeyboard,
} from '../keyboards/sleep.keyboard.js';
```

- [ ] **Step 2: Add the `/sleep` command handler**

At the end of `command.handler.ts`, before the final export (or at the bottom of the file after all other commands):

```typescript
bot.command('sleep', async (ctx: Context) => {
  const window = await getSleepWindow();
  const enabled = window !== null;

  let text: string;
  if (enabled) {
    const startStr = window.startHour.toString().padStart(2, '0');
    const endStr = window.endHour.toString().padStart(2, '0');
    text = `Sleep hours: ${startStr}:00 – ${endStr}:00 ✅\nPosts scheduled during this window will be pushed to after ${endStr}:00.`;
  } else {
    text = 'Sleep hours: disabled';
  }

  await ctx.reply(text, { reply_markup: createSleepStatusKeyboard(enabled) });
});
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot/handlers/command.handler.ts
git commit -m "feat: add /sleep command to show and configure sleep window"
```

---

### Task 5: `sleep:*` callbacks

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`

- [ ] **Step 1: Add imports to `callback.handler.ts`**

Add after the existing imports:

```typescript
import { getSleepWindow } from '../../utils/sleep-window.js';
import { BotSettings } from '../../database/models/bot-settings.model.js';
import {
  createSleepStatusKeyboard,
  createHourPickerKeyboard,
  createSleepConfirmKeyboard,
} from '../keyboards/sleep.keyboard.js';
```

- [ ] **Step 2: Add the sleep helper and callbacks**

At the bottom of `callback.handler.ts` (after all existing callback registrations), add:

```typescript
// ──────────────────────────────────────────────
// Sleep window configuration callbacks
// ──────────────────────────────────────────────

async function showSleepStatus(ctx: Context): Promise<void> {
  const window = await getSleepWindow();
  const enabled = window !== null;

  let text: string;
  if (enabled) {
    const startStr = window.startHour.toString().padStart(2, '0');
    const endStr = window.endHour.toString().padStart(2, '0');
    text = `Sleep hours: ${startStr}:00 – ${endStr}:00 ✅\nPosts scheduled during this window will be pushed to after ${endStr}:00.`;
  } else {
    text = 'Sleep hours: disabled';
  }

  await ctx.editMessageText(text, { reply_markup: createSleepStatusKeyboard(enabled) });
}

async function saveSleepSettings(
  enabled: boolean,
  startHour?: number,
  endHour?: number
): Promise<void> {
  const ops: Promise<unknown>[] = [
    BotSettings.findOneAndUpdate(
      { key: 'sleep_enabled' },
      { key: 'sleep_enabled', value: String(enabled), updatedAt: new Date() },
      { upsert: true }
    ),
  ];
  if (startHour !== undefined && endHour !== undefined) {
    ops.push(
      BotSettings.findOneAndUpdate(
        { key: 'sleep_start' },
        { key: 'sleep_start', value: String(startHour), updatedAt: new Date() },
        { upsert: true }
      ),
      BotSettings.findOneAndUpdate(
        { key: 'sleep_end' },
        { key: 'sleep_end', value: String(endHour), updatedAt: new Date() },
        { upsert: true }
      )
    );
  }
  await Promise.all(ops);
}

// sleep:enable — show start hour picker
bot.callbackQuery('sleep:enable', async (ctx: Context) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Select start hour:', {
    reply_markup: createHourPickerKeyboard('start'),
  });
});

// sleep:change — same as enable (show start hour picker)
bot.callbackQuery('sleep:change', async (ctx: Context) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Select start hour:', {
    reply_markup: createHourPickerKeyboard('start'),
  });
});

// sleep:disable — disable and show updated status
bot.callbackQuery('sleep:disable', async (ctx: Context) => {
  await ctx.answerCallbackQuery();
  await saveSleepSettings(false);
  await showSleepStatus(ctx);
});

// sleep:start:<h> — store start, show end picker
bot.callbackQuery(/^sleep:start:(\d+)$/, async (ctx: Context) => {
  await ctx.answerCallbackQuery();
  const match = ctx.callbackQuery?.data?.match(/^sleep:start:(\d+)$/);
  const startHour = parseInt(match![1], 10);
  await ctx.editMessageText('Select end hour:', {
    reply_markup: createHourPickerKeyboard('end', startHour),
  });
});

// sleep:end:<start>:<h> — show confirm screen
bot.callbackQuery(/^sleep:end:(\d+):(\d+)$/, async (ctx: Context) => {
  const match = ctx.callbackQuery?.data?.match(/^sleep:end:(\d+):(\d+)$/);
  const startHour = parseInt(match![1], 10);
  const endHour = parseInt(match![2], 10);

  if (endHour <= startHour) {
    await ctx.answerCallbackQuery({ text: 'End hour must be after start hour', show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();

  const startStr = startHour.toString().padStart(2, '0');
  const endStr = endHour.toString().padStart(2, '0');
  await ctx.editMessageText(`Sleep hours: ${startStr}:00 – ${endStr}:00\n\nConfirm?`, {
    reply_markup: createSleepConfirmKeyboard(startHour, endHour),
  });
});

// sleep:confirm:<start>:<end> — save and show status
bot.callbackQuery(/^sleep:confirm:(\d+):(\d+)$/, async (ctx: Context) => {
  await ctx.answerCallbackQuery();
  const match = ctx.callbackQuery?.data?.match(/^sleep:confirm:(\d+):(\d+)$/);
  const startHour = parseInt(match![1], 10);
  const endHour = parseInt(match![2], 10);
  await saveSleepSettings(true, startHour, endHour);
  await showSleepStatus(ctx);
});

// sleep:cancel — discard changes, show current status
bot.callbackQuery('sleep:cancel', async (ctx: Context) => {
  await ctx.answerCallbackQuery();
  await showSleepStatus(ctx);
});
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot/handlers/callback.handler.ts
git commit -m "feat: add sleep:* callback handlers for sleep window configuration"
```

---

### Task 6: Register `/sleep` command hint

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add `/sleep` to `setMyCommands` in `src/index.ts`**

Find the `setMyCommands` call (around line 31–45). Add one entry to the array — put it after the `queue` entry:

```typescript
{ command: 'sleep', description: 'Configure sleep hours (no posts during window)' },
```

The full updated array should be:
```typescript
await bot.api.setMyCommands([
  { command: 'start', description: 'Show welcome message' },
  { command: 'help', description: 'Show help and available commands' },
  { command: 'addchannel', description: 'Add a new posting channel' },
  { command: 'removechannel', description: 'Remove a posting channel' },
  { command: 'listchannels', description: 'List all configured channels' },
  { command: 'status', description: 'View scheduled posts' },
  { command: 'queue', description: 'View and manage the post queue' },
  { command: 'sleep', description: 'Configure sleep hours (no posts during window)' },
  { command: 'addgreen', description: 'Add channel to green list (reply to message)' },
  { command: 'addred', description: 'Add channel to red list (reply to message)' },
  { command: 'remove', description: 'Remove channel from lists (reply to message)' },
  { command: 'setnickname', description: 'Set nickname for a user' },
  { command: 'removenickname', description: 'Remove nickname for a user' },
  { command: 'listnicknames', description: 'List all configured nicknames' },
]);
```

- [ ] **Step 2: Final build verification**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no errors.

- [ ] **Step 3: Run all tests**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npx vitest run
```

Expected: all tests pass including the 5 new `sleep-window` tests.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: register /sleep command hint in setMyCommands"
```
