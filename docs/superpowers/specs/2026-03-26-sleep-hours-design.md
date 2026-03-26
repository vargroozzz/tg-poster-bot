# Sleep Hours Feature — Design Spec

**Date:** 2026-03-26

## Overview

Add a configurable "sleep window" during which no posts are scheduled. Posts that would fall inside the window are pushed to the first slot after it ends. The window is configured via the bot's inline keyboard UI using the `/sleep` command.

---

## Data & Storage

Uses the existing `BotSettings` key-value model. Three keys:

| Key | Values | Default |
|---|---|---|
| `sleep_enabled` | `"true"` / `"false"` | `"false"` (disabled) |
| `sleep_start` | `"0"` – `"23"` | `"1"` |
| `sleep_end` | `"0"` – `"23"` | `"9"` |

A single `find({ key: { $in: ['sleep_enabled', 'sleep_start', 'sleep_end'] } })` fetches all three.

**Constraint:** `startHour < endHour` only. Midnight-crossing windows (e.g. 22–06) are not supported and not needed.

---

## New File: `src/utils/sleep-window.ts`

Two exports:

### `getSleepWindow()`
Reads the three `BotSettings` keys in one query. Returns:
```ts
{ enabled: boolean; startHour: number; endHour: number } | null
```
Returns `null` if sleep is disabled or settings are missing. Callers treat `null` as "no window active" and skip `skipSleepWindow` entirely.

### `skipSleepWindow(slot: Date, window: SleepWindow): Date`
Pure function (no DB). Converts `slot` to Europe/Kyiv timezone, checks if its hour falls in `[startHour, endHour)`. If so, returns `endHour:00:01` of the same day (in Kyiv time, converted back to UTC). Otherwise returns `slot` unchanged.

---

## Slot Calculation Changes (`src/utils/time-slots.ts`)

`findNextAvailableSlot` gets one new step. `getSleepWindow()` is called once at the top, then passed to `skipSleepWindow` at two points:

```
1. Calculate raw nextSlotAfterNow via calculateNextSlot()
2. effectiveNextSlot = skipSleepWindow(nextSlotAfterNow, window)
3. Find latestPending for targetChannelId
4. If latestPending.scheduledTime >= effectiveNextSlot:
     candidate = latestPending.scheduledTime + 30min
     return skipSleepWindow(candidate, window)
5. Else return effectiveNextSlot
```

No changes to `PostSchedulerService` or `PostWorkerService`.

---

## Bot UI

### Command: `/sleep`

Registered in `command.handler.ts`. Reads current settings and shows the status message. If no settings exist in DB yet, treated as disabled (no defaults are pre-written to DB).

**When enabled:**
```
Sleep hours: 01:00 – 09:00 ✅
Posts scheduled during this window will be pushed to after 09:00.

[Change hours]  [Disable]
```

**When disabled:**
```
Sleep hours: disabled

[Enable]
```

### New File: `src/bot/keyboards/sleep.keyboard.ts`

Three keyboard builders:
- `createSleepStatusKeyboard(enabled: boolean)` — status view buttons
- `createHourPickerKeyboard(phase: 'start', startHour?: never): InlineKeyboard` — buttons emit `sleep:start:<h>`
- `createHourPickerKeyboard(phase: 'end', startHour: number): InlineKeyboard` — buttons emit `sleep:end:<startHour>:<h>`
- `createSleepConfirmKeyboard(start: number, end: number)` — confirm/cancel

### Callback Chain (`callback.handler.ts`)

| Callback data | Action |
|---|---|
| `sleep:enable` | Show hour picker, prompt "Select start hour:" |
| `sleep:disable` | Set `sleep_enabled=false` in DB, show updated status |
| `sleep:start:<h>` | Show end hour picker, prompt "Select end hour:" |
| `sleep:end:<start>:<h>` | Show confirm message with [Confirm] [Cancel] |
| `sleep:confirm:<start>:<end>` | Save all 3 keys to DB, show updated status |
| `sleep:cancel` | Show current status (no changes) |

Transient state (start hour) travels in the callback data string — no session state needed.

---

## Files Changed / Created

| File | Change |
|---|---|
| `src/utils/sleep-window.ts` | **New** — `getSleepWindow`, `skipSleepWindow` |
| `src/utils/time-slots.ts` | Modified — call `skipSleepWindow` in `findNextAvailableSlot` |
| `src/bot/keyboards/sleep.keyboard.ts` | **New** — status, hour picker, confirm keyboards |
| `src/bot/handlers/command.handler.ts` | Add `/sleep` command |
| `src/bot/handlers/callback.handler.ts` | Add `sleep:*` callback handlers |
| `src/index.ts` | Register `/sleep` in `setMyCommands` |
