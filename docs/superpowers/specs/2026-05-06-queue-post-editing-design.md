# Queue Post Editing — Design Spec

## Overview

Add an "✏️ Edit" button to the queue post preview view. Clicking it starts a full re-flow (channel → transform/forward → text handling → nickname → custom text → preview) for that scheduled post. At confirm:

- **Same channel selected** → update the post in-place, keep its `scheduledTime`
- **Different channel selected** → cascade-delete old post, schedule a new one in the new channel's queue

The flow uses `sessionId`-embedded callback data throughout — no `reply_to_message` dependency, no message forwarding.

---

## Behaviour

### Entry point

User is viewing a queue post preview (preview messages + control message with keyboard). They click "✏️ Edit":

1. Post is fetched from DB
2. Queue preview messages and control message are cleaned up
3. An edit session is created in DB, pre-seeded with the post's last choices
4. A fresh "Select channel:" message is sent to the user with an edit-specific channel keyboard

### Re-flow steps

Identical logic to the normal scheduling flow (green/red list check, state machine transitions, auto-nickname selection), but:

- Every keyboard button embeds `sessionId` in its callback data: `queue:edit:ch:{sessionId}:{channelId}`, `queue:edit:action:{sessionId}:{action}`, etc.
- Session is looked up by ID directly — no `reply_to_message` involved
- Pre-filled defaults from the post (channel, action, textHandling, nickname, customText) let the user confirm without changing anything

### Confirm (`preview:schedule` with `editingPostId` set)

**Same channel:**
- If `action === 'transform'`: re-run transformation using `session.rawContent` + new session choices to produce updated `content`
- If `action === 'forward'`: no transformation; `content` stays as `rawContent`
- Call `repository.updatePost(editingPostId, { content, action, textHandling, selectedNickname, customText, rawContent })`
- `scheduledTime` is not touched
- Reply: "✅ Post updated!"

**Different channel:**
- `queueService.deleteAndCascade(editingPostId)`
- Call normal `postScheduler.scheduleTransformPost` or `postScheduler.scheduleForwardPost` for new channel
- Reply: "✅ Moved to [channel], scheduled for [time]"

### Back (`preview:back` with `editingPostId` set)

Re-send the edit channel selection message. No reply context needed.

### Cancel (`preview:cancel` with `editingPostId` set)

Original post stays in queue untouched. Edit session is deleted. Reply: "Edit cancelled."

---

## Data Model Changes

### `ScheduledPost` — 4 new optional fields

```typescript
rawContent?: MessageContent      // pre-transformation content (before text handling + attribution)
textHandling?: TextHandling      // 'keep' | 'remove' | 'quote'
selectedNickname?: string | null // attribution nickname chosen during scheduling
customText?: string              // custom text prefix chosen during scheduling
```

Saved at scheduling time by `PostSchedulerService` for both transform and forward posts.

### `Session` — 3 new optional fields + relaxed `originalMessage`

```typescript
editingPostId?: string               // if set, this is an edit session
editingOriginalChannelId?: string    // channel at edit start (to detect channel change at confirm)
editingOriginalScheduledTime?: Date  // time slot to preserve if same channel selected
```

`originalMessage` becomes `required: false`. Edit sessions have no real original message.

`messageId: 0` is used as a sentinel for edit sessions (Telegram message IDs start at 1, no collision). The compound unique index `{ userId, messageId }` limits one edit session per user at a time — intentional.

Edit sessions are pre-seeded at creation with `selectedChannel`, `selectedAction`, `textHandling`, `selectedNickname`, and `customText` from the post, so the user can confirm without changing anything.

---

## New Files

### `src/bot/keyboards/edit-channel-select.keyboard.ts`

Channel selection keyboard with `queue:edit:ch:{sessionId}:{channelId}` callback data per button.

### `src/bot/handlers/queue-edit.handler.ts`

All `queue:edit:*` callbacks:

| Callback pattern | Action |
|---|---|
| `queue:edit:{postId}` | Entry point — create edit session, send channel select |
| `queue:edit:ch:{sessionId}:{channelId}` | Channel selected |
| `queue:edit:action:{sessionId}:{action}` | Transform / forward / quick selected |
| `queue:edit:text:{sessionId}:{handling}` | Text handling selected |
| `queue:edit:nickname:{sessionId}:{key}` | Nickname selected |
| `queue:edit:custom:{sessionId}:(add\|skip)` | Custom text add/skip |
| `queue:edit:custom:preset:{sessionId}:{presetId}` | Preset selected |

Each callback: fetch session by ID → update session → show next keyboard (buttons embed `sessionId`). Preview step reuses `PreviewGeneratorService` + `PreviewSenderService`; `rawContent` from session is used as base content when `originalMessage` is absent.

---

## Modified Files

| File | Change |
|---|---|
| `src/database/models/scheduled-post.model.ts` | Add 4 new fields to schema + interface |
| `src/database/models/session.model.ts` | Add 3 new fields, `originalMessage` → `required: false` |
| `src/core/posting/post-scheduler.service.ts` | Save `rawContent`, `textHandling`, `selectedNickname`, `customText` when scheduling |
| `src/database/repositories/scheduled-post.repository.ts` | Add `updatePost(id, updates)` method |
| `src/core/session/session.service.ts` | Add `createForEdit(userId, post)` method |
| `src/core/preview/preview-generator.service.ts` | Use `rawContent` from session when `originalMessage` absent |
| `src/bot/keyboards/queue-preview-action.keyboard.ts` | Add "✏️ Edit" button → `queue:edit:{postId}` |
| `src/bot/handlers/callback.handler.ts` | Branch on `editingPostId` in `preview:schedule`, `preview:back`, `preview:cancel` |

---

## Error Handling

- **Post gone at edit click** (already published or deleted between preview and click) → answer callback query with toast "Post already published or deleted", no-op
- **`queuePreviewStateMap` missing** (bot restarted) → still create edit session and proceed; clean up only the control message
- **Edit session expired mid-flow** (24h TTL) → reply "Edit session expired, use /queue to start again"
- **`preview:schedule` update failure** → leave original post intact, reply with error message

---

## Out of Scope

- Editing the scheduled time directly (rescheduling without changing channel)
- Bulk editing multiple posts
- Editing posts in `posted` or `failed` status
