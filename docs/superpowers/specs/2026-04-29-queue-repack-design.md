# Queue Repack Design

## Goal

After changing the post interval, allow the user to reschedule all pending posts to consecutive slots at the new interval — starting from the next clean slot after now.

## Trigger

After a successful `interval:set:*` callback, the confirmation message includes a second keyboard row: **"Reschedule queue to X min intervals"** (callback data `interval:repack`). This button is absent from the initial `/interval` command display.

## Repack Logic (`QueueRepackService`)

Located at `src/core/queue/queue-repack.service.ts`.

### `repackAll(): Promise<{ totalPosts: number; channelCount: number }>`

1. Read current interval via `getPostInterval()` and sleep window via `getSleepWindow()` (parallel).
2. Get all distinct `targetChannelId` values with `status: 'pending'` via `ScheduledPost.distinct(...)`.
3. For each channel, call `repackChannel(channelId, intervalMinutes, sleepWindow)`.
4. Sum results and return `{ totalPosts, channelCount }`.

### `repackChannel(channelId, intervalMinutes, sleepWindow)`

1. Fetch all pending posts sorted by `scheduledTime` ascending via `ScheduledPostRepository.findPendingByChannel`.
2. If empty, return `0`.
3. Compute first slot:
   ```
   nowInTz = toZonedTime(new Date(), TIMEZONE)
   firstSlotInTz = calculateNextSlotForInterval(nowInTz, intervalMinutes)
   firstSlotUtc = fromZonedTime(firstSlotInTz, TIMEZONE)
   firstSlot = sleepWindow ? skipSleepWindow(firstSlotUtc, sleepWindow) : firstSlotUtc
   ```
4. Build `newTimes[]` — a consecutive slot sequence of length `posts.length`:
   ```
   slots[0] = firstSlot
   for i in 1..n-1:
     candidate = addMinutes(slots[i-1], intervalMinutes)
     slots[i] = sleepWindow ? skipSleepWindow(candidate, sleepWindow) : candidate
   ```
5. Determine update order to avoid triggering the unique index on `(scheduledTime, targetChannelId)`:
   - If `newTimes[0] <= posts[0].scheduledTime` (compressing or same start): update **first-to-last**
   - Otherwise (expanding): update **last-to-first**
6. Apply `post.updateOne({ $set: { scheduledTime: newTime } })` sequentially in the chosen order.
7. Return `posts.length`.

## Keyboard Changes

`createIntervalKeyboard(currentInterval, showRepack?: boolean)`:
- Always renders the three interval buttons on row 1.
- If `showRepack` is true, adds a row 2: `[Reschedule queue to {currentInterval} min intervals]` with data `interval:repack`.

## Callback Changes

**`interval:set:*`** — after saving the new interval, call `createIntervalKeyboard(minutes, true)` (adds repack button).

**`interval:repack`** (new) — reads interval, calls `QueueRepackService.repackAll()`, edits message:
- Posts found: `Queue repacked ✅\n{N} posts across {M} channels rescheduled to {X}-minute intervals.`
- Nothing to do: `No pending posts to reschedule.`

## Files

| Action | Path |
|--------|------|
| Create | `src/core/queue/queue-repack.service.ts` |
| Modify | `src/bot/keyboards/interval.keyboard.ts` |
| Modify | `src/bot/handlers/callback.handler.ts` |

No new commands, no schema changes, no index changes needed.

## Edge Cases

- **No pending posts**: repack returns `{ totalPosts: 0, channelCount: 0 }` → show "No pending posts" message.
- **Single post**: works — one channel, one slot, no ordering concern.
- **Posts already due (scheduledTime in the past)**: `calculateNextSlotForInterval` always returns a future slot, so all posts move to the future.
- **Sleep window active**: `skipSleepWindow` applied at each slot step, same as scheduling.
