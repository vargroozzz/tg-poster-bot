# Telegram Channel Poster Bot - Developer Guide

## Project Overview

This bot schedules Telegram channel posts with automatic attribution. It's designed for a single authorized user who curates content from various sources (users, channels) and schedules them to their channels at specific time slots (hh:00:01 or hh:30:01 in Europe/Kyiv timezone).

## Key Architecture Decisions

### Scheduling System: Cron-Based, Not Telegram Bot API

**Why:** Telegram Bot API's `schedule_date` parameter doesn't work for channels (returns positive message_id, indicating immediate posting rather than scheduling).

**Solution:**
- Posts are saved to MongoDB with `status: 'pending'`
- Background worker (`PostWorkerService`) runs every 30 seconds
- Worker queries for posts where `status='pending'` AND `scheduledTime <= now`
- Posts are published using regular Telegram API (no schedule_date)
- Status updated to `posted` or `failed`

**Files:**
- `src/services/post-worker.service.ts` - Background worker
- `src/services/scheduler.service.ts` - Slot calculation and DB storage
- `src/database/models/scheduled-post.model.ts` - Schema with status field

### Multi-Channel Architecture

Users can manage multiple posting channels and select destination per message.

**Files:**
- `src/database/models/posting-channel.model.ts` - Posting channels
- `src/bot/keyboards/channel-select.keyboard.ts` - Channel selection UI

### Attribution System

Three types of sources with different attribution rules:

1. **Green-listed channels:** Auto-forward as-is using `copyMessage` (no transformation, no user interaction)
2. **Red-listed channels:** Auto-transform (skips Transform/Forward choice), omits channel reference, shows only "via [nickname]" if user selected
3. **Regular channels/users/non-forwarded:** Show Transform/Forward choice, add attribution based on channel link and/or nickname

**Custom Nicknames:** Users can set friendly names for people (stored in `user-nickname` collection). Nicknames are **always** selected via inline keyboard during Transform flow, regardless of whether the message is forwarded or original content. If "No attribution" selected, user attribution is omitted entirely.

**Message Sources:**
- **Forwarded from channels:** Can show channel link + nickname
- **Forwarded from users:** Can show nickname
- **Original content (non-forwarded):** Can show nickname attribution

**Forward vs Transform:**
- **Forward:** Uses Telegram's `copyMessage` API to preserve "Forwarded from" attribution (only for forwarded messages)
- **Transform:** Extracts content, adds custom attribution, sends as new message

**Files:**
- `src/services/transformer.service.ts` - Attribution logic
- `src/database/models/user-nickname.model.ts` - User nicknames
- `src/database/models/channel-list.model.ts` - Green/red lists

### Text Handling Options

For messages with text/caption, users can choose:
- **Keep:** Leave as-is
- **Remove:** Strip all text/caption
- **Quote:** Wrap in `<blockquote>` tags

**Files:**
- `src/bot/keyboards/text-handling.keyboard.ts` - Text options UI
- `src/types/message.types.ts` - TextHandling type

## Flow Diagrams

### Message Scheduling Flow
```
1. User sends message to bot (forwarded OR original content - photos, videos, documents, etc.)
2. Bot shows channel selection buttons
3. User selects target channel
4. Bot checks source (only for forwarded messages):
   - If GREEN-LISTED → Auto-forward immediately (skip to step 9)
   - If RED-LISTED → Auto-transform (skip to step 6, no Transform/Forward choice)
   - Otherwise (or non-forwarded) → Show Transform/Forward buttons (step 5)
5. User selects Transform or Forward:
   - FORWARD → Skip to step 9 (uses copyMessage, no modifications)
   - TRANSFORM → Continue to step 6
6. If message has text → Show text handling options (Keep/Remove/Quote)
7. Show nickname selection (or "No attribution") - ALWAYS shown during Transform
8. Show custom text option (Add custom text / Skip)
9. Bot calculates next available slot (hh:00:01 or hh:30:01)
10. Saves to MongoDB with status='pending'
11. Background worker posts at scheduled time using:
    - copyMessage for 'forward' action (preserves "Forwarded from")
    - sendPhoto/sendVideo/etc for 'transform' action (new message with attribution)
```

### Attribution Logic Flow
```
1. If action is 'forward' → Return original text (no transformation)
2. Check if source is green-listed → Return original text
3. Check if from channel:
   - If red-listed:
     * Has nickname selected → "via [nickname]" (NO channel reference)
     * No nickname → No attribution
   - If NOT red-listed AND has messageLink:
     * Has nickname selected → "from [nickname] via [channel link]"
     * No nickname → "via [channel link]"
4. Check if from user (not via channel):
   - If has custom nickname → "via [nickname]"
   - Otherwise → No attribution
```

## Database Schema

### ScheduledPost
```typescript
{
  scheduledTime: Date,           // When to post (UTC)
  targetChannelId: string,       // Destination channel
  status: 'pending' | 'posted' | 'failed',
  originalForward: ForwardInfo,  // Source metadata
  content: MessageContent,       // Transformed content
  action: 'transform' | 'forward',
  postedAt?: Date,               // When actually posted
  error?: string,                // Error message if failed
  createdAt: Date
}
```

### UserNickname
```typescript
{
  userId: number,
  nickname: string,              // Custom friendly name
  addedAt: Date,
  notes?: string
}
```

### PostingChannel
```typescript
{
  channelId: string,
  channelTitle?: string,
  channelUsername?: string,
  isActive: boolean,
  addedAt: Date
}
```

### ChannelList
```typescript
{
  channelId: string,
  listType: 'green' | 'red',
  channelTitle?: string,
  channelUsername?: string,
  addedAt: Date
}
```

## Critical Code Patterns

### Using Grammy Raw API
Grammy's types don't include all Telegram parameters. Use raw API with type assertions:
```typescript
const result = (await this.api.raw.sendPhoto({
  chat_id: channelId,
  photo: fileId,
  caption: text,
  parse_mode: 'HTML',
} as any)) as any;
```

### HTML Parse Mode, Not Markdown
Use `parse_mode: 'HTML'` for blockquote support:
```typescript
// Correct
<blockquote>quoted text</blockquote>
<a href="url">link text</a>

// Wrong (old Markdown mode)
> quoted text
[link text](url)
```

### Reply-Driven Commands
Commands can extract IDs from replied-to messages:
```typescript
const replyToMessage = ctx.message?.reply_to_message;
if (replyToMessage) {
  const forwardInfo = parseForwardInfo(replyToMessage);
  const channelId = forwardInfo?.fromChannelId;
  // Use channelId without user having to provide it
}
```

### Timezone Handling
All times stored as UTC in MongoDB, converted to Europe/Kyiv for slot calculation:
```typescript
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

const nowUtc = new Date();
const nowInTz = toZonedTime(nowUtc, 'Europe/Kiev');
// Calculate slot in Kyiv timezone
const slotUtc = fromZonedTime(nextSlot, 'Europe/Kiev');
```

### Media Group Buffering
Telegram sends media group items as separate messages with shared `media_group_id`. Buffer them before processing:
```typescript
// Buffer messages for 1 second to collect all items
const mediaGroupBuffers = new Map<string, MediaGroupBuffer>();

if (mediaGroupId) {
  const buffer = mediaGroupBuffers.get(mediaGroupId);
  if (buffer) {
    buffer.messages.push(message);
    clearTimeout(buffer.timeout);
    buffer.timeout = setTimeout(() => processMediaGroup(mediaGroupId), 1000);
  } else {
    const timeout = setTimeout(() => processMediaGroup(mediaGroupId), 1000);
    mediaGroupBuffers.set(mediaGroupId, { messages: [message], timeout });
  }
  return; // Don't process yet
}
```

### Forward vs Transform in Post Worker
The post worker uses different APIs based on the action:
```typescript
// For 'forward' action - use copyMessage to preserve attribution
if (post.action === 'forward') {
  result = await this.api.copyMessage(
    post.targetChannelId,
    post.originalForward.chatId,
    post.originalForward.messageId
  );
}

// For 'transform' action - send as new message with transformed content
else if (post.content.type === 'photo') {
  result = await this.api.sendPhoto(post.targetChannelId, post.content.fileId, {
    caption: post.content.text,
    parse_mode: 'HTML'
  });
}
```

### Handling Both Forwarded and Non-Forwarded Messages
Bot listens to multiple message types, not just forwards:
```typescript
// Handle both forwarded and non-forwarded messages
bot.on([
  'message:forward_origin',  // Forwarded messages
  'message:photo',           // Original photos
  'message:video',           // Original videos
  'message:document',        // Original documents
  'message:animation'        // Original GIFs/animations
], async (ctx: Context) => {
  // Process all types uniformly
});
```

**parseForwardInfo always returns ForwardInfo:**
```typescript
// For forwarded messages: full info with fromChannelId, fromUserId, etc.
// For non-forwarded messages: minimal info with just messageId and chatId
const forwardInfo = parseForwardInfo(message); // Never null

// Check if it's actually a forward
const isForwarded = forwardInfo.fromChannelId !== undefined ||
                    forwardInfo.fromUserId !== undefined;
```

## Common Pitfalls

### ❌ Don't use `schedule_date` parameter
It doesn't work for channels via Bot API. Use the background worker instead.

### ❌ Don't use `as never` for type assertions
Use `as any` or proper typing. `as never` can cause subtle bugs.

### ❌ Don't use Markdown parse mode
Telegram's blockquotes require HTML mode. We switched from Markdown to HTML.

### ❌ Don't cast to just `any` everywhere
Only use `as any` when bypassing Grammy's incomplete types for valid Telegram parameters.

### ❌ Don't use `||` when `??` is more suitable
Prefer nullish coalescing for clarity:
```typescript
// Good
const name = username ?? title ?? 'Unknown';

// Bad
const name = username || title || 'Unknown';
```

### ❌ Don't show Transform/Forward choice for red-listed channels
Red-listed channels should auto-transform without asking. Check `isRedListed` before showing the action buttons.

### ❌ Don't re-send content for forward action
Use `copyMessage` API to preserve "Forwarded from" attribution, not `sendPhoto`/`sendVideo`/etc.

### ❌ Don't check for null on parseForwardInfo
`parseForwardInfo` always returns a ForwardInfo object (never null). For non-forwarded messages, it returns minimal info (messageId, chatId only).

### ❌ Don't limit nickname selection to forwarded messages only
Nickname selection should **always** show during Transform flow, even for non-forwarded original content.

### ✅ Do verify builds before committing
Always run `npm run build` to catch TypeScript errors.

### ✅ Do check if code has already been deployed
Check logs to verify if new code is running before debugging.

## Environment Variables

```env
BOT_TOKEN=              # From @BotFather
MONGODB_URI=            # MongoDB Atlas connection string
AUTHORIZED_USER_ID=     # Single user allowed to use bot
NODE_ENV=production     # Environment mode
TZ=Europe/Kiev          # Timezone for scheduling
PORT=3000               # HTTP health check port
WEBHOOK_URL=            # Webhook URL for production (e.g., https://yourdomain.onrender.com)
```

**Webhook vs Long Polling:**
- Production uses webhooks (`WEBHOOK_URL` set) to prevent 409 Conflict errors during deployments
- Development uses long polling (no `WEBHOOK_URL`) for easier testing
- Webhooks allow multiple instances during zero-downtime deployments

## Deployment (Render)

- **Service Type:** Web Service (has HTTP health check endpoint)
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- **Auto-Deploy:** Enabled via GitHub webhook
- **Health Check:** `GET /health` returns `{"status": "ok"}`

### Why Web Service, Not Background Worker?
The bot runs continuously and has an HTTP endpoint for health checks, so it's configured as a Web Service rather than a Background Worker.

## Testing Locally

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build
npm run build

# Run production build
npm start
```

## Key Files to Know

- `src/index.ts` - Entry point, starts bot and worker
- `src/services/post-worker.service.ts` - **Critical:** Background worker that posts messages
- `src/services/scheduler.service.ts` - Slot calculation and scheduling
- `src/services/transformer.service.ts` - Attribution logic
- `src/bot/handlers/callback.handler.ts` - Handles all inline button clicks
- `src/bot/handlers/forward.handler.ts` - Handles forwarded messages
- `src/bot/handlers/command.handler.ts` - All bot commands
- `src/utils/time-slots.ts` - Time slot calculation (hh:00:01 or hh:30:01)

## Implemented Features

- [x] Media group support (albums with multiple photos/videos)
- [x] Inline nickname selection with "No attribution" option (always shown in Transform flow)
- [x] Custom text feature (prepend text to posts)
- [x] Multi-channel support with channel selection
- [x] Webhooks deployment (prevents 409 conflicts)
- [x] True forwarding via copyMessage (preserves "Forwarded from")
- [x] Non-forwarded message support (original photos, videos, documents can be scheduled)
- [x] User attribution for any message type (forwarded or original)

## Future Improvements

- [ ] Edit scheduled posts before they're published
- [ ] Cancel/delete scheduled posts
- [ ] Statistics dashboard
- [ ] Preview transformed message before scheduling
- [ ] Batch scheduling
