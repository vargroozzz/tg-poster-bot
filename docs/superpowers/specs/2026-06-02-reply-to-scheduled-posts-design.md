# Reply to Scheduled Posts — Design Spec

## Overview

Users can attach a reply to any scheduled post. The reply goes through the full scheduling flow (transform/forward, text handling, nickname, custom text, preview) and can be sent either atomically with the parent ("together") or at its own independent slot ("separated").

---

## Data Model

### `IScheduledPost` additions

**Together replies — embedded sub-document on the parent:**

```typescript
embeddedReply?: {
  targetChannelId: string;        // may differ from parent
  content: MessageContent;
  rawContent?: MessageContent;
  action: TransformAction;
  textHandling?: TextHandling;
  selectedUserId?: number | null;
  customText?: string;
  originalForward: ForwardInfo;
}
embeddedReplyError?: string;      // set if embedded reply fails to publish
```

No separate document. Worker publishes parent → gets `message_id` → immediately publishes the embedded reply with `reply_parameters`.

**Separated replies — three new fields on a new `IScheduledPost`:**

```typescript
parentPostId?: ObjectId;        // links this doc to its parent
replyToMessageId?: number;      // parent's Telegram message_id (filled on parent publish)
replyToChannelId?: string;      // parent's targetChannelId (filled at same time)
```

New status value added to the existing `'pending' | 'posted' | 'failed'` enum: `'waiting_parent'`. The worker ignores documents in this state until the parent publishes, at which point it fills `replyToMessageId`/`replyToChannelId` and flips status to `'pending'`.

### `ISession` additions

```typescript
isReply?: boolean;
replyParentPostId?: string;
replyMode?: 'together' | 'separated';
```

### New `SessionState` values

- `WAITING_FOR_REPLY_CONTENT` — bot is waiting for the user to send reply content
- `REPLY_SLOT_CHOICE` — user choosing "same slot" vs "next available slot"

---

## Session Flow

### Entry points

**1. Inline — after scheduling a post:**
The scheduling confirmation message gains a "💬 Add a reply" button. Clicking it creates a new session with `isReply = true`, `replyParentPostId` set, and state `WAITING_FOR_REPLY_CONTENT`.

**2. Via `/queue`:**
The queue preview action keyboard gains an "Add reply" button. Clicking it creates the same session.

### Full flow

```
[WAITING_FOR_REPLY_CONTENT]
  Bot: "Send the content for this reply. You can forward a message or send any media/text."
  User sends any message.
  → forward.handler checks for a WAITING_FOR_REPLY_CONTENT session before
    creating a new standalone session. If found: populates originalMessage,
    advances state to CHANNEL_SELECTION.

[CHANNEL_SELECTION]
  Same as normal flow. Target channel may differ from parent.

[REPLY_SLOT_CHOICE]  ← new step, inserted after channel selection
  Bot: "When should this reply be sent?"
  Keyboard: [📎 Same slot as parent]  [⏭ Next available slot]
  → saves replyMode on session, continues to ACTION_SELECTION.

[ACTION_SELECTION → TEXT_HANDLING → NICKNAME → CUSTOM_TEXT → PREVIEW]
  Identical to normal scheduling flow.

[SCHEDULING]
  replyMode = 'together'
    → transform/schedule as usual to get content
    → update parent document: set embeddedReply field
    → confirm: "↩️ Reply scheduled with the parent post at [time]"

  replyMode = 'separated'
    → create new IScheduledPost with:
         parentPostId, status: 'waiting_parent', own scheduledTime
    → confirm: "↩️ Reply scheduled for [time]"
```

---

## Worker & Publisher

### `PostWorkerService.publishPost`

After successfully publishing a post:

```typescript
const messageId = await this.publisher.publish(post);
await post.updateOne({ status: 'posted', postedAt: new Date(), telegramScheduledMessageId: messageId });

// Together reply: publish atomically in the same cycle
if (post.embeddedReply) {
  await this.publisher.publishEmbeddedReply(post.embeddedReply, messageId, post.targetChannelId);
}

// Separated reply: unblock it
await ScheduledPost.updateMany(
  { parentPostId: post._id, status: 'waiting_parent' },
  { replyToMessageId: messageId, replyToChannelId: post.targetChannelId, status: 'pending' }
);
```

The existing worker query (`status: 'pending', scheduledTime: { $lte: now }`) requires no changes — `'waiting_parent'` documents are invisible to it.

### `PostPublisherService`

**New `publishEmbeddedReply(reply, parentMessageId, parentChannelId)`:**
Runs the same transform/forward logic as `publish()`, injecting `reply_parameters: { message_id: parentMessageId, chat_id: parentChannelId }` into the outgoing send call.

**Existing `publish()` for separated replies:**
If `post.replyToMessageId` is set, thread `reply_parameters` through to `MediaSenderService`. The transform/forward logic is unchanged.

**Cross-chat replies:**
Telegram's `reply_parameters` supports `chat_id` for cross-chat replies. When the reply's `targetChannelId` differs from `replyToChannelId`, both fields are passed so Telegram renders the cross-channel reference.

---

## UI Touchpoints

### New keyboards

**`reply-slot.keyboard.ts`**
```
[📎 Same slot as parent]  [⏭ Next available slot]
```

**`reply-trigger.keyboard.ts`**
Single "💬 Add a reply" button appended to the scheduling confirmation message.

### Modified keyboards

**`queue-preview-action.keyboard.ts`** — add "💬 Add reply" button alongside existing actions.

### New callback prefixes

| Prefix | Payload | Handler |
|--------|---------|---------|
| `reply_trigger` | `<parentPostId>` | Creates reply session from confirmation |
| `queue_reply` | `<postId>` | Creates reply session from queue preview |
| `reply_slot:together` | `<sessionId>` | Sets replyMode = 'together' |
| `reply_slot:separated` | `<sessionId>` | Sets replyMode = 'separated' |

### Bot messages

| Moment | Message |
|--------|---------|
| After trigger clicked | *"Send the content for this reply. You can forward a message or send any media/text."* |
| `REPLY_SLOT_CHOICE` prompt | *"When should this reply be sent?"* + slot keyboard |
| Confirm together | *"↩️ Reply scheduled with the parent post at [time]"* |
| Confirm separated | *"↩️ Reply scheduled for [time]"* |

---

## Edge Cases

- **Parent post fails to publish:** Separated reply stays `'waiting_parent'` indefinitely. The `/queue` view should surface this. No auto-cancellation in v1.
- **Parent already posted when reply is added via `/queue`:** If `status === 'posted'`, `telegramScheduledMessageId` is already set — create the reply as a normal `'pending'` post with `replyToMessageId`/`replyToChannelId` filled immediately. No `'waiting_parent'` step needed.
- **Together reply publish fails:** Log error, mark embedded reply failure separately (add `embeddedReplyError?: string` field). Parent is already posted so no rollback.
- **Multiple replies to same parent:** Supported — each is independent (one embedded together reply OR multiple separated reply documents). Two embedded together replies are not supported (single `embeddedReply` field).
