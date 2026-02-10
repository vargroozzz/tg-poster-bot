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

1. **Green-listed channels:** Auto-forward as-is (no transformation)
2. **Red-listed channels:** Omit channel attribution, only add user nickname if available
3. **Regular channels/users:** Add attribution based on custom nickname or channel link

**Custom Nicknames:** Users can set friendly names for people (stored in `user-nickname` collection). If no nickname is set, user attribution is omitted entirely.

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
1. User forwards message to bot
2. Bot shows channel selection buttons
3. User selects target channel
4. If message has text → Show text handling options (Keep/Remove/Quote)
5. User selects text handling
6. Bot shows Transform/Forward buttons
7. User selects action
8. Bot calculates next available slot (hh:00:01 or hh:30:01)
9. Saves to MongoDB with status='pending'
10. Background worker posts at scheduled time
```

### Attribution Logic Flow
```
1. Check if source is green-listed → Return original text
2. Check if from channel:
   - If red-listed AND has user → Add user nickname (if set)
   - If NOT red-listed AND has messageLink → Add channel link
3. Check if from user:
   - If has custom nickname → Add nickname
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
```

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

## Future Improvements

- [ ] Media group support (albums with multiple photos)
- [ ] Edit scheduled posts before they're published
- [ ] Cancel/delete scheduled posts
- [ ] Statistics dashboard
- [ ] Preview transformed message before scheduling
- [ ] Batch scheduling
