# Telegram Channel Poster Bot - Developer Guide

## Table of Contents

- [Project Overview](#project-overview)
- [Quick Start](#quick-start)
- [Key Architecture Decisions](#key-architecture-decisions)
- [Flow Diagrams](#flow-diagrams)
- [Database Schema](#database-schema)
- [Bot Commands](#bot-commands)
- [Critical Code Patterns](#critical-code-patterns)
- [Common Pitfalls](#common-pitfalls)
- [Error Handling & Logging](#error-handling--logging)
- [Troubleshooting](#troubleshooting)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
- [Key Files](#key-files-to-know)

## Project Overview

This bot schedules Telegram channel posts with automatic attribution. It's designed for a single authorized user who curates content from various sources (users, channels) and schedules them to their channels at specific time slots (hh:00:01 or hh:30:01 in Europe/Kyiv timezone).

**Key Features:**
- Schedule posts to multiple channels
- Automatic attribution with customizable nicknames
- Forward or transform messages
- Green/red list management for channels
- Text handling options (keep/remove/quote)
- Media group (album) support
- Webhook-based deployment for zero-downtime updates

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up environment variables (copy from .env.example)
cp .env.example .env
# Edit .env with your BOT_TOKEN, MONGODB_URI, and AUTHORIZED_USER_ID

# 3. Run in development mode
npm run dev

# 4. Send a message to your bot to test scheduling
```

**First-time setup commands:**
1. `/addchannel` - Add your posting channel(s)
2. Forward a message - Test the scheduling flow
3. `/list` - View scheduled posts

## System Architecture

```
┌─────────────────┐
│  Telegram API   │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│              Grammy Bot (index.ts)                  │
│  ┌──────────────────────────────────────────────┐   │
│  │  Message Handler (forward.handler.ts)        │   │
│  │  - Receives messages (forwarded or original) │   │
│  │  - Shows channel selection                   │   │
│  │  - Shows Transform/Forward/Text options      │   │
│  │  - Calls SchedulerService                    │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  Callback Handler (callback.handler.ts)      │   │
│  │  - Processes inline button clicks            │   │
│  │  - Manages flow state                        │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  Command Handler (command.handler.ts)        │   │
│  │  - /addchannel, /greenlist, /list, etc.     │   │
│  └──────────────────────────────────────────────┘   │
└──────────────────┬───────────────────────────────────┘
                   │
                   ▼
         ┌─────────────────────┐
         │  SchedulerService   │
         │  - Calculate slots  │
         │  - Save to MongoDB  │
         └─────────┬───────────┘
                   │
                   ▼
         ┌─────────────────────┐         ┌──────────────────┐
         │   MongoDB Atlas     │◄────────┤ PostWorkerService│
         │  - ScheduledPost    │         │  (runs every 30s)│
         │  - PostingChannel   │         │                  │
         │  - UserNickname     │         │  1. Query pending│
         │  - ChannelList      │         │  2. Check time   │
         └─────────────────────┘         │  3. Post to TG   │
                                         │  4. Update status│
                                         └──────────────────┘
```

**Key Components:**
- **Grammy Bot**: Handles incoming messages and commands via webhooks or polling
- **SchedulerService**: Calculates next available time slot, saves to database
- **PostWorkerService**: Background cron job that publishes scheduled posts
- **TransformerService**: Applies attribution and text transformations
- **MongoDB**: Stores scheduled posts, configuration, nicknames

**Data Flow:**
1. User sends message → Bot receives it
2. User makes choices (channel, transform/forward, text handling, nickname)
3. SchedulerService calculates next slot and saves to DB
4. PostWorkerService runs every 30s, finds due posts, publishes them
5. Status updated to 'posted' or 'failed'

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

1. **Green-listed channels:** Auto-forward as-is using `forwardMessage` (no transformation, no user interaction)
2. **Red-listed channels:** Auto-transform (skips Transform/Forward choice), omits channel reference, shows only "via [nickname]" if user selected
3. **Regular channels/users/non-forwarded:** Show Transform/Forward choice, add attribution based on channel link and/or nickname

**Custom Nicknames:** Users can set friendly names for people (stored in `user-nickname` collection). Nicknames are **always** selected via inline keyboard during Transform flow, regardless of whether the message is forwarded or original content. If "No attribution" selected, user attribution is omitted entirely.

**Message Sources:**
- **Forwarded from channels:** Can show channel link + nickname
- **Forwarded from users:** Can show nickname
- **Original content (non-forwarded):** Can show nickname attribution

**Forward vs Transform:**
- **Forward:** Uses Telegram's `forwardMessage` API to preserve "Forwarded from" attribution (only for forwarded messages)
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
   - FORWARD → Skip to step 9 (uses forwardMessage, no modifications)
   - TRANSFORM → Continue to step 6
6. If message has text → Show text handling options (Keep/Remove/Quote)
7. Show nickname selection (or "No attribution") - ALWAYS shown during Transform
8. Show custom text option (Add custom text / Skip)
9. Bot calculates next available slot (hh:00:01 or hh:30:01)
10. Saves to MongoDB with status='pending'
11. Background worker posts at scheduled time using:
    - forwardMessage for 'forward' action (preserves "Forwarded from")
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

## Bot Commands

### Posting Channel Management
- `/addchannel` - Add a new posting channel (must be admin of the channel)
- `/listchannels` - List all configured posting channels
- `/removechannel <channelId>` - Remove a posting channel

### Schedule Management
- `/list` - View all scheduled posts
- `/stats` - View posting statistics
- Forward any message - Start the scheduling flow

### Channel Lists (Attribution Control)
- `/greenlist [reply]` - Add channel to green list (auto-forward without changes)
- `/redlist [reply]` - Add channel to red list (auto-transform, hide channel link)
- `/removelist [reply]` - Remove channel from green/red lists
- `/listgreen` - Show all green-listed channels
- `/listred` - Show all red-listed channels

**Tip:** Use reply-to-message for list commands to auto-extract channel ID

### Nickname Management
- `/addnickname <userId> <nickname>` - Add a custom nickname for a user
- `/listnicknames` - Show all configured nicknames
- `/removenickname <userId>` - Remove a nickname

### Other
- `/start` - Show welcome message
- `/help` - Show help text

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
const nowInTz = toZonedTime(nowUtc, 'Europe/Kyiv');
// Calculate slot in Kyiv timezone
const slotUtc = fromZonedTime(nextSlot, 'Europe/Kyiv');
```

**Note:** Use `'Europe/Kyiv'` (not `'Europe/Kiev'`) consistently throughout the codebase.

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
// For 'forward' action - use forwardMessage to preserve attribution
if (post.action === 'forward') {
  result = await this.api.forwardMessage(
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
Use `forwardMessage` API to preserve "Forwarded from" attribution, not `sendPhoto`/`sendVideo`/etc.

### ❌ Don't check for null on parseForwardInfo
`parseForwardInfo` always returns a ForwardInfo object (never null). For non-forwarded messages, it returns minimal info (messageId, chatId only).

### ❌ Don't limit nickname selection to forwarded messages only
Nickname selection should **always** show during Transform flow, even for non-forwarded original content.

### ✅ Do verify builds before committing
Always run `npm run build` to catch TypeScript errors.

### ✅ Do check if code has already been deployed
Check logs to verify if new code is running before debugging.

## Error Handling & Logging

### Error Handling Strategy

**Post Worker Errors:**
- Failed posts are marked with `status: 'failed'` and `error` field in database
- Worker continues processing other posts even if one fails
- Errors are logged with full context for debugging

**Telegram API Errors:**
- Rate limit errors (429): Implement exponential backoff
- Permission errors: Log and mark post as failed
- Network errors: Retry with timeout

**Pattern:**
```typescript
try {
  await this.api.sendPhoto(channelId, fileId, options);
  await post.updateOne({ status: 'posted', postedAt: new Date() });
} catch (error) {
  console.error(`Failed to post: ${error.message}`, { postId: post._id });
  await post.updateOne({
    status: 'failed',
    error: error.message
  });
}
```

### Logging

**Production Logging:**
- Use `console.log` for normal operations
- Use `console.error` for errors with context
- Include relevant IDs (postId, channelId, userId) in logs
- Render captures stdout/stderr automatically

**What to Log:**
- Post scheduling events
- Post publishing events (success/failure)
- Worker execution cycles (at INFO level, not every cycle)
- Telegram API errors
- Authorization failures

**What NOT to Log:**
- Full message content (privacy)
- Bot token or sensitive credentials
- Every webhook request (too noisy)

### Telegram API Rate Limits

**Limits:**
- 30 messages per second to the same group
- 20 messages per minute to different users
- Webhooks: 1 request per second

**Handling:**
- Post worker runs every 30 seconds (well under rate limits)
- For bulk operations, add delays between API calls
- Catch 429 errors and implement retry with backoff

## Troubleshooting

### Bot Not Responding

1. **Check authorization:**
   ```bash
   # Verify AUTHORIZED_USER_ID matches your Telegram user ID
   # Send /start to bot, check logs for authorization errors
   ```

2. **Check webhook status:**
   ```bash
   # View Render logs for webhook errors
   # Verify WEBHOOK_URL is set correctly in production
   ```

3. **Check if bot is running:**
   ```bash
   curl https://your-app.onrender.com/health
   # Should return {"status": "ok"}
   ```

### Posts Not Publishing

1. **Check post worker logs:**
   ```bash
   # Look for "Post worker running..." messages
   # Check for error messages during post processing
   ```

2. **Query database:**
   ```javascript
   // Check pending posts in MongoDB
   db.scheduledposts.find({ status: 'pending' })

   // Check failed posts
   db.scheduledposts.find({ status: 'failed' })
   ```

3. **Verify bot permissions:**
   - Bot must be admin of target channel
   - Bot needs permission to post messages

### 409 Conflict Errors

**Cause:** Multiple bot instances running (old deployment still alive)

**Solution:**
- Use webhooks in production (set `WEBHOOK_URL`)
- Webhooks prevent multiple instances from polling
- Render's zero-downtime deployment handles graceful shutdown

### Timezone Issues

**Symptom:** Posts scheduled at wrong time

**Solution:**
- All times in DB are UTC
- Display times converted to Europe/Kyiv
- Verify `TZ=Europe/Kyiv` environment variable is set
- Check server time: `date` command should show correct timezone

### Media Group Not Working

**Symptom:** Album posts as individual messages

**Cause:** Media group buffer timeout too short or messages not grouped

**Debug:**
```typescript
// Add logging in media group handler
console.log('Media group received:', {
  mediaGroupId,
  messageCount: buffer.messages.length
});
```

### TypeScript Build Errors

**Always verify builds before committing:**
```bash
npm run build
# Fix all TypeScript errors before pushing
```

**Common issues:**
- Missing type imports
- Incorrect use of `as any` (should only be used for Grammy API limitations)
- Null safety violations (use `??` operator)

## Environment Variables

```env
BOT_TOKEN=              # From @BotFather
MONGODB_URI=            # MongoDB Atlas connection string
AUTHORIZED_USER_ID=     # Single user allowed to use bot (Telegram user ID)
NODE_ENV=production     # Environment mode
TZ=Europe/Kyiv          # Timezone for scheduling (use Kyiv, not Kiev)
PORT=3000               # HTTP health check port
WEBHOOK_URL=            # Webhook URL for production (e.g., https://yourdomain.onrender.com)
```

**Security Notes:**
- Never commit `.env` file to git (included in `.gitignore`)
- `BOT_TOKEN` must be kept secret - revoke and regenerate if exposed
- `AUTHORIZED_USER_ID` restricts bot to single user - all other requests are rejected
- Use environment variables in Render dashboard, not hardcoded values

**Webhook vs Long Polling:**
- Production uses webhooks (`WEBHOOK_URL` set) to prevent 409 Conflict errors during deployments
- Development uses long polling (no `WEBHOOK_URL`) for easier testing
- Webhooks allow multiple instances during zero-downtime deployments

**Finding Your User ID:**
```
1. Send any message to @userinfobot on Telegram
2. It will reply with your user ID
3. Use this number for AUTHORIZED_USER_ID
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

# Run in development mode (uses long polling)
npm run dev

# Build TypeScript
npm run build

# Run production build
npm start

# Run linting
npm run lint
```

### Testing Strategy

**Manual Testing:**
1. Start bot in development mode (`npm run dev`)
2. Send test messages to bot
3. Verify scheduling flow works
4. Check database for scheduled posts
5. Wait for post worker to publish (or adjust scheduledTime manually)
6. Verify posts appear in channel

**Testing Commands:**
```bash
# Test channel management
/addchannel
/listchannels

# Test list management (reply to a forwarded message)
/greenlist
/redlist

# Test scheduling
# Forward a message, follow the flow

# Test post worker (check logs)
# Posts should appear at hh:00:01 or hh:30:01
```

**Database Queries for Debugging:**
```javascript
// View pending posts
db.scheduledposts.find({ status: 'pending' }).sort({ scheduledTime: 1 })

// View recent posted messages
db.scheduledposts.find({ status: 'posted' }).sort({ postedAt: -1 }).limit(10)

// View failed posts
db.scheduledposts.find({ status: 'failed' })

// Manually trigger a post (set time to past)
db.scheduledposts.updateOne(
  { _id: ObjectId('...') },
  { $set: { scheduledTime: new Date() } }
)
```

**Unit Testing:**
Currently no automated tests. Future improvement: add Jest tests for:
- Time slot calculation logic
- Attribution transformation logic
- Message parsing utilities

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
- [x] True forwarding via forwardMessage (preserves "Forwarded from")
- [x] Non-forwarded message support (original photos, videos, documents can be scheduled)
- [x] User attribution for any message type (forwarded or original)

## Future Improvements

- [ ] Edit scheduled posts before they're published
- [ ] Cancel/delete scheduled posts
- [ ] Statistics dashboard
- [ ] Preview transformed message before scheduling
- [ ] Batch scheduling
