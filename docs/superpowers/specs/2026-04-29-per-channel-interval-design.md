# Per-Channel Post Interval Design

## Goal

Allow each posting channel to have its own post interval (15 / 30 / 60 min), configurable via a two-step `/interval` command. Falls back to 30 min when not set.

## Schema Change

Add `postInterval` to `PostingChannel`:

```typescript
postInterval?: number;  // one of 15, 30, 60 — absent means 30
```

Optional field, no Mongoose migration needed — existing documents simply lack it and receive the default.

## `post-interval.ts` Rewrite

`getPostInterval(channelId: string): Promise<PostInterval>` — reads `PostingChannel.findOne({ channelId })`, returns `postInterval ?? 30`, validates against `VALID_INTERVALS`.

`setPostInterval(channelId: string, minutes: PostInterval): Promise<void>` — updates `PostingChannel` via `findOneAndUpdate`.

`VALID_INTERVALS` and `PostInterval` type are unchanged. The old `BotSettings` `post_interval` key is abandoned — all callers have a `channelId`.

## `/interval` Command — Two-Step Flow

### Step 1: Channel list

Text:
```
Post intervals:
• My Channel A — 15 min
• My Channel B — 30 min
```

One button per channel (each on its own row): label = channel title, data = `interval:ch:<channelId>`.

### Step 2: Channel picker (after tapping a channel)

Text: `Post interval for <channelTitle>: <current> min`

Row 1: `[✓ 15 min]` / `[30 min]` / `[60 min]` — data `interval:set:<channelId>:<minutes>`

Row 2: `[Reschedule queue to <current> min intervals]` — data `interval:repack:<channelId>`

Row 3: `[← Back]` — data `interval:back`

After setting an interval, the message updates in place (✓ moves to new selection, repack button label updates).

## Callbacks

| Data pattern | Action |
|---|---|
| `interval:ch:<channelId>` | Show channel picker (step 2) |
| `interval:set:<channelId>:<minutes>` | Save interval, refresh picker |
| `interval:repack:<channelId>` | Repack that channel, show result + picker |
| `interval:back` | Return to channel list (step 1) |

## Core Logic Changes

**`findNextAvailableSlot(targetChannelId)`** — calls `getPostInterval(targetChannelId)` (was `getPostInterval()`). No other change.

**`QueueRepackService`:**
- `repackAll()` no longer reads a global interval — each `repackChannel()` call reads the channel's own interval from the DB
- `repackChannel(channelId)` becomes public (no other params — reads interval internally)
- Return type of `repackAll()` unchanged: `{ totalPosts, channelCount }`

## Files

| Action | Path |
|---|---|
| Modify | `src/database/models/posting-channel.model.ts` |
| Rewrite | `src/utils/post-interval.ts` |
| Modify | `src/utils/time-slots.ts` |
| Modify | `src/core/queue/queue-repack.service.ts` |
| Rewrite | `src/bot/keyboards/interval.keyboard.ts` |
| Modify | `src/bot/handlers/command.handler.ts` |
| Modify | `src/bot/handlers/callback.handler.ts` |

## Tests

`src/core/queue/__tests__/queue-repack.test.ts` — existing `computeRepackSlots` tests unchanged; no new tests needed (all new logic is DB reads with simple fallbacks, not pure functions).

## Out of Scope

`shiftPostsEarlier` in `ScheduledPostRepository` still hardcodes -30 min. Not changed here.
