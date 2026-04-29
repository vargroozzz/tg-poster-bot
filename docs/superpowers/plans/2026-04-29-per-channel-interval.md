# Per-Channel Post Interval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the global post interval with a per-channel setting stored on `PostingChannel`, with a two-step `/interval` command (channel list → interval picker per channel).

**Architecture:** `PostingChannel.postInterval` stores the per-channel value (absent = 30 min default). `getPostInterval(channelId?)` reads it, falling back to the global `BotSettings` key then 30. A new `setChannelInterval(channelId, minutes)` writes to `PostingChannel`. The `/interval` command and all callbacks are redesigned around a channel-first flow.

**Tech Stack:** TypeScript, Grammy, Mongoose/MongoDB, Vitest, date-fns, date-fns-tz

---

### Task 1: Add `postInterval` to `PostingChannel` schema

**Files:**
- Modify: `src/database/models/posting-channel.model.ts`

- [ ] **Step 1: Add field to interface and schema**

In `src/database/models/posting-channel.model.ts`, add `postInterval?: number` to `IPostingChannel` and the Mongoose schema:

```typescript
export interface IPostingChannel extends Document {
  channelId: string;
  channelUsername?: string;
  channelTitle?: string;
  postInterval?: number;
  addedAt: Date;
  isActive: boolean;
}

const postingChannelSchema = new Schema<IPostingChannel>({
  channelId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  channelUsername: String,
  channelTitle: String,
  postInterval: {
    type: Number,
  },
  addedAt: {
    type: Date,
    default: Date.now,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
});
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && git add src/database/models/posting-channel.model.ts && git commit -m "feat: add postInterval field to PostingChannel schema"
```

---

### Task 2: Expand `post-interval.ts` with per-channel support

**Files:**
- Modify: `src/utils/post-interval.ts`

- [ ] **Step 1: Replace the file**

```typescript
import { BotSettings } from '../database/models/bot-settings.model.js';
import { PostingChannel } from '../database/models/posting-channel.model.js';

export const VALID_INTERVALS = [15, 30, 60] as const;
export type PostInterval = (typeof VALID_INTERVALS)[number];

/**
 * Read post interval for a channel. Falls back to global BotSettings key,
 * then to 30 if neither is set.
 */
export async function getPostInterval(channelId?: string): Promise<PostInterval> {
  if (channelId != null) {
    const channel = await PostingChannel.findOne({ channelId }).select('postInterval');
    if (channel?.postInterval != null) {
      const val = channel.postInterval;
      return VALID_INTERVALS.includes(val as PostInterval) ? (val as PostInterval) : 30;
    }
  }
  const setting = await BotSettings.findOne({ key: 'post_interval' });
  const parsed = parseInt(setting?.value ?? '30', 10);
  return VALID_INTERVALS.includes(parsed as PostInterval) ? (parsed as PostInterval) : 30;
}

/** Write interval for a specific channel. */
export async function setChannelInterval(channelId: string, minutes: PostInterval): Promise<void> {
  await PostingChannel.findOneAndUpdate(
    { channelId },
    { $set: { postInterval: minutes } },
    { new: true }
  );
}

/** Legacy: writes to global BotSettings key. Kept for backwards compatibility. */
export async function setPostInterval(minutes: PostInterval): Promise<void> {
  await BotSettings.findOneAndUpdate(
    { key: 'post_interval' },
    { key: 'post_interval', value: String(minutes), updatedAt: new Date() },
    { upsert: true, new: true }
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no TypeScript errors. All existing callers still compile because `getPostInterval()` still accepts no args.

- [ ] **Step 3: Run tests**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npx vitest run
```

Expected: all 34 tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && git add src/utils/post-interval.ts && git commit -m "feat: add per-channel getPostInterval and setChannelInterval"
```

---

### Task 3: Pass `channelId` to `getPostInterval` in time-slots

**Files:**
- Modify: `src/utils/time-slots.ts`

- [ ] **Step 1: Update `findNextAvailableSlot`**

In `src/utils/time-slots.ts`, find this block inside `findNextAvailableSlot`:

```typescript
const [sleepWindow, intervalMinutes] = await Promise.all([
  getSleepWindow(),
  getPostInterval(),
]);
```

Change it to:

```typescript
const [sleepWindow, intervalMinutes] = await Promise.all([
  getSleepWindow(),
  getPostInterval(targetChannelId),
]);
```

- [ ] **Step 2: Verify build and tests**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build && npx vitest run
```

Expected: build clean, all 34 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && git add src/utils/time-slots.ts && git commit -m "feat: pass channelId to getPostInterval in findNextAvailableSlot"
```

---

### Task 4: Per-channel interval in `QueueRepackService`

**Files:**
- Modify: `src/core/queue/queue-repack.service.ts`

- [ ] **Step 1: Rewrite the service**

Replace the entire file:

```typescript
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
    const channelIds = (await ScheduledPost.distinct('targetChannelId', {
      status: 'pending',
    })) as string[];

    const counts = await Promise.all(
      channelIds.map((channelId) => this.repackChannel(channelId))
    );
    const totalPosts = counts.reduce((sum, n) => sum + n, 0);

    return { totalPosts, channelCount: channelIds.length };
  }

  async repackChannel(channelId: string): Promise<number> {
    const [posts, intervalMinutes, sleepWindow] = await Promise.all([
      this.repository.findPendingByChannel(channelId),
      getPostInterval(channelId),
      getSleepWindow(),
    ]);

    if (posts.length === 0) return 0;

    // Compute first slot from scratch rather than using findNextAvailableSlot,
    // because that function advances past the latest pending post — repack ignores
    // the existing schedule and starts fresh from now.
    const nowInTz = toZonedTime(new Date(), TIMEZONE);
    const firstSlotInTz = calculateNextSlotForInterval(nowInTz, intervalMinutes);
    const firstSlotUtc = fromZonedTime(firstSlotInTz, TIMEZONE);
    const firstSlot = sleepWindow ? skipSleepWindow(firstSlotUtc, sleepWindow) : firstSlotUtc;

    const newTimes = computeRepackSlots(posts.length, firstSlot, intervalMinutes, sleepWindow);

    // Update order avoids unique-index conflicts on (scheduledTime, targetChannelId):
    // expanding (new end > old end) → last-to-first
    // compressing or same end → first-to-last
    const expanding = newTimes[newTimes.length - 1] > posts[posts.length - 1].scheduledTime;
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

- [ ] **Step 2: Verify build and tests**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build && npx vitest run
```

Expected: build clean, all 34 tests pass (the `computeRepackSlots` tests are unchanged).

- [ ] **Step 3: Commit**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && git add src/core/queue/queue-repack.service.ts && git commit -m "feat: repackChannel reads interval per-channel, make it public"
```

---

### Task 5: Rewrite interval keyboard for two-step flow

**Files:**
- Modify: `src/bot/keyboards/interval.keyboard.ts`

- [ ] **Step 1: Replace the file**

```typescript
import { InlineKeyboard } from 'grammy';
import { VALID_INTERVALS, type PostInterval } from '../../utils/post-interval.js';

interface Channel {
  channelId: string;
  channelTitle?: string | null;
}

export function createChannelIntervalListKeyboard(channels: Channel[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const channel of channels) {
    const label = channel.channelTitle ?? channel.channelId;
    keyboard.text(label, `interval:ch:${channel.channelId}`).row();
  }
  return keyboard;
}

export function createChannelIntervalPickerKeyboard(
  channelId: string,
  currentInterval: PostInterval
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const minutes of VALID_INTERVALS) {
    const label = currentInterval === minutes ? `✓ ${minutes} min` : `${minutes} min`;
    keyboard.text(label, `interval:set:${channelId}:${minutes}`);
  }
  keyboard
    .row()
    .text(`Reschedule queue to ${currentInterval} min intervals`, `interval:repack:${channelId}`)
    .row()
    .text('← Back', 'interval:back');
  return keyboard;
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: TypeScript errors for old `createIntervalKeyboard` callers in `command.handler.ts` and `callback.handler.ts`. Note these — they will be fixed in Tasks 6 and 7.

- [ ] **Step 3: Commit**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && git add src/bot/keyboards/interval.keyboard.ts && git commit -m "feat: replace interval keyboard with two-step channel-first version"
```

Note: the build will fail after this commit until Tasks 6 and 7 are done. Do NOT push between Task 5 and Task 7.

---

### Task 6: Update `/interval` command to show channel list

**Files:**
- Modify: `src/bot/handlers/command.handler.ts`

- [ ] **Step 1: Update imports**

In `src/bot/handlers/command.handler.ts`, replace:

```typescript
import { getPostInterval } from '../../utils/post-interval.js';
import { createIntervalKeyboard } from '../keyboards/interval.keyboard.js';
```

With:

```typescript
import { getPostInterval } from '../../utils/post-interval.js';
import { createChannelIntervalListKeyboard } from '../keyboards/interval.keyboard.js';
```

- [ ] **Step 2: Replace the `/interval` command handler**

Find and replace the entire `bot.command('interval', ...)` block with:

```typescript
bot.command('interval', async (ctx: Context) => {
  try {
    const channels = await getActivePostingChannels();
    if (channels.length === 0) {
      await ctx.reply('No posting channels configured. Add one with /addchannel first.');
      return;
    }
    const intervals = await Promise.all(channels.map((ch) => getPostInterval(ch.channelId)));
    const lines = channels
      .map((ch, i) => `• ${ch.channelTitle ?? ch.channelId} — ${intervals[i]} min`)
      .join('\n');
    await ctx.reply(`Post intervals:\n${lines}`, {
      reply_markup: createChannelIntervalListKeyboard(channels),
    });
  } catch (error) {
    logger.error('Error in /interval command:', error);
    await ctx.reply('Error loading interval settings. Please try again.');
  }
});
```

- [ ] **Step 3: Verify build (still expected to fail)**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: errors only in `callback.handler.ts` (old `createIntervalKeyboard` calls). That file gets fixed in Task 7.

- [ ] **Step 4: Commit**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && git add src/bot/handlers/command.handler.ts && git commit -m "feat: update /interval to show per-channel list"
```

---

### Task 7: Replace interval callbacks with per-channel versions

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`

- [ ] **Step 1: Update imports**

Find the existing interval-related imports (around lines 43–44):

```typescript
import { getPostInterval, setPostInterval, VALID_INTERVALS, type PostInterval } from '../../utils/post-interval.js';
import { createIntervalKeyboard } from '../keyboards/interval.keyboard.js';
```

Replace with:

```typescript
import { getPostInterval, setChannelInterval, VALID_INTERVALS, type PostInterval } from '../../utils/post-interval.js';
import { createChannelIntervalListKeyboard, createChannelIntervalPickerKeyboard } from '../keyboards/interval.keyboard.js';
```

- [ ] **Step 2: Remove old interval callbacks**

Find and delete the entire `// Post interval configuration callbacks` section — the two callbacks registered with `/^interval:set:(\d+)$/` and `'interval:repack'`. Delete from the `// ──────────────` comment down through the closing `});` of the `interval:repack` callback (lines ~1302–1357).

- [ ] **Step 3: Add new interval callbacks at the end of the file**

Append this entire block:

```typescript
// ──────────────────────────────────────────────
// Per-channel post interval callbacks
// ──────────────────────────────────────────────

// interval:ch:<channelId> — show picker for a specific channel
bot.callbackQuery(/^interval:ch:(-?\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const channelId = ctx.match[1];
    const [channel, currentInterval] = await Promise.all([
      PostingChannel.findOne({ channelId }),
      getPostInterval(channelId),
    ]);
    const title = channel?.channelTitle ?? channelId;
    await ctx.editMessageText(
      `Post interval for ${title}: ${currentInterval} min\n\nSelect a new interval:`,
      { reply_markup: createChannelIntervalPickerKeyboard(channelId, currentInterval) }
    );
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error loading channel interval. Please try again.',
      'interval:ch callback'
    );
  }
});

// interval:set:<channelId>:<minutes> — save interval for a channel
bot.callbackQuery(/^interval:set:(-?\d+):(\d+)$/, async (ctx: Context) => {
  try {
    const channelId = ctx.match[1];
    const minutes = parseInt(ctx.match[2], 10);

    if (!VALID_INTERVALS.includes(minutes as PostInterval)) {
      await ctx.answerCallbackQuery('Invalid interval.');
      return;
    }

    await ctx.answerCallbackQuery();
    await setChannelInterval(channelId, minutes as PostInterval);

    const channel = await PostingChannel.findOne({ channelId });
    const title = channel?.channelTitle ?? channelId;
    await ctx.editMessageText(
      `Post interval for ${title}: ${minutes} min ✅`,
      { reply_markup: createChannelIntervalPickerKeyboard(channelId, minutes as PostInterval) }
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

// interval:repack:<channelId> — repack queue for a specific channel
bot.callbackQuery(/^interval:repack:(-?\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const channelId = ctx.match[1];
    const repackService = new QueueRepackService();
    const [count, currentInterval, channel] = await Promise.all([
      repackService.repackChannel(channelId),
      getPostInterval(channelId),
      PostingChannel.findOne({ channelId }),
    ]);
    const title = channel?.channelTitle ?? channelId;
    const text =
      count === 0
        ? `No pending posts to reschedule for ${title}.`
        : `Queue repacked ✅\n${count} post${count === 1 ? '' : 's'} for ${title} rescheduled to ${currentInterval}-min intervals.`;
    await ctx.editMessageText(text, {
      reply_markup: createChannelIntervalPickerKeyboard(channelId, currentInterval),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error repacking queue. Please try again.',
      'interval:repack callback'
    );
  }
});

// interval:back — return to channel list
bot.callbackQuery('interval:back', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const channels = await getActivePostingChannels();
    const intervals = await Promise.all(channels.map((ch) => getPostInterval(ch.channelId)));
    const lines = channels
      .map((ch, i) => `• ${ch.channelTitle ?? ch.channelId} — ${intervals[i]} min`)
      .join('\n');
    const text =
      channels.length === 0
        ? 'No posting channels configured.'
        : `Post intervals:\n${lines}`;
    await ctx.editMessageText(text, {
      reply_markup: createChannelIntervalListKeyboard(channels),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      'Error loading intervals. Please try again.',
      'interval:back callback'
    );
  }
});
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: **no TypeScript errors**. This is the first clean build since Task 5.

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npx vitest run
```

Expected: all 34 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && git add src/bot/handlers/callback.handler.ts && git commit -m "feat: replace interval callbacks with per-channel flow"
```

---

### Task 8: Push to remote

- [ ] **Step 1: Push**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && git push
```

Expected: branch pushed, Render auto-deploy triggered.
