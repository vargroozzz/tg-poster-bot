# Telegram Channel Poster Bot - Developer Guide

## Workflow Notes

- Do NOT commit design docs or implementation plans. Write them to disk if needed but skip the commit — execution follows immediately.

## Checking Render Logs (MCP)

Use the Render MCP tools to check production logs without leaving the session:

```
1. mcp__render__list_workspaces          — list available workspaces
2. mcp__render__select_workspace         — select "My Workspace" (id: tea-d0ea6jhr0fns73cu3gj0)
3. mcp__render__list_services            — find the service id (tg-poster-bot: srv-d653fplum26s73bjd9ug)
4. mcp__render__list_logs                — fetch logs for that service id
```

Example log query for recent errors:
```json
{
  "resource": ["srv-d653fplum26s73bjd9ug"],
  "type": ["app"],
  "text": ["error", "Error"],
  "limit": 50
}
```

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
- `/addchannel <channelId>` - Add a new posting channel (must be admin of the channel)
- `/listchannels` - List all configured posting channels and green/red lists
- `/removechannel <channelId>` - Remove a posting channel

### Schedule Management
- `/status` - View pending scheduled posts count and next 5 posts
- `/queue` - View and manage the post queue by channel
- Forward any message - Start the scheduling flow

### Channel Lists (Attribution Control)
- `/addgreen [reply]` - Add channel to green list (auto-forward without changes)
- `/addred [reply]` - Add channel to red list (auto-transform, hide channel link)
- `/remove [reply]` - Remove channel from green/red lists

**Tip:** Use reply-to-message for list commands to auto-extract channel ID

### Nickname Management
- `/addnickname <userId> <nickname>` - Add a custom nickname for a user (reply-driven supported)
- `/listnicknames` - Show all configured nicknames
- `/removenickname <userId>` - Remove a nickname (reply-driven supported)

### Sleep Window
- `/sleep` - View or configure sleep hours (no posts scheduled during this window)

### Custom Text Presets
- `/addpreset <label> | <text>` - Save a reusable custom text preset
- `/listpresets` - Show all presets with their IDs
- `/removepreset <id>` - Delete a preset by ID

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
  'message:animation',       // Original GIFs/animations
  'message:text'             // Text messages (forwarded or original)
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

### Dual-Read Pattern for Session Management
During migration from in-memory Map to database-backed sessions, use dual-read pattern for resilience:
```typescript
// Try database first
const sessionSvc = getSessionService();
if (sessionSvc && userId) {
  try {
    session = await sessionSvc.findWaitingForCustomText(userId) ?? undefined;
    if (session) {
      foundKey = session._id.toString();
      logger.debug(`Found session in DB for user ${userId}`);
    }
  } catch (error) {
    logger.error('Error fetching session from DB, falling back to Map:', error);
  }
}

// Fall back to Map if not found in DB
if (!session) {
  for (const [key, value] of pendingForwards.entries()) {
    if (value.waitingForCustomText) {
      foundEntry = [key, value];
      foundKey = key;
      logger.debug(`Found session in Map for user ${userId}`);
      break;
    }
  }
}
```

### Idempotency Checks for Zero-Downtime Deployments
Prevent duplicate processing during Render's zero-downtime deployments (when two instances briefly run):
```typescript
async function processSingleMessage(ctx: Context, message: Message) {
  // Idempotency check: Skip if we already have a session for this message
  // This prevents duplicate processing during zero-downtime deployments
  const sessionSvc = getSessionService();
  if (sessionSvc && ctx.from?.id) {
    try {
      const existingSession = await sessionSvc.findByMessage(ctx.from.id, message.message_id);
      if (existingSession) {
        logger.debug(`Session already exists for message ${message.message_id}, skipping duplicate processing`);
        return;
      }
    } catch (error) {
      logger.error('Error checking for existing session:', error);
      // Continue processing if check fails (fail open)
    }
  }

  // Continue with normal processing...
}
```

### Filtering Message Handlers to Prevent Conflicts
When handling text messages for custom text input, use `.filter()` to only catch replies (not all text):
```typescript
// CORRECT: Only handle text messages that are replies
bot.on('message:text').filter((ctx) => !!ctx.message?.reply_to_message, async (ctx: Context) => {
  // This only processes replies to bot messages (custom text input)
  // Regular forwarded text messages go to the main handler
});

// WRONG: Catches ALL text messages including forwarded ones
bot.on('message:text', async (ctx: Context) => {
  // This blocks text forwarding from reaching the main handler
});
```

### Auto-Nickname Selection
Automatically select nickname for known users to streamline workflow:
```typescript
async function handleNicknameSelection(
  ctx: Context,
  originalMessage: Message,
  sessionId?: string
): Promise<boolean> {
  const forwardInfo = parseForwardInfo(originalMessage);
  const fromUserId = forwardInfo?.fromUserId;

  if (fromUserId) {
    const nickname = await NicknameHelper.findNicknameByUserId(fromUserId);
    if (nickname) {
      logger.debug(`Auto-selecting nickname "${nickname}" for user ${fromUserId}`);

      // Auto-select and proceed to custom text
      const sessionSvc = getSessionService();
      if (sessionId && sessionSvc) {
        await sessionSvc.update(sessionId, { selectedNickname: nickname });
      }

      const keyboard = createCustomTextKeyboard();
      await ctx.editMessageText('Do you want to add custom text to this post?', {
        reply_markup: keyboard,
      });
      return true; // Handled automatically
    }
  }

  // Show selection keyboard if no nickname found
  const keyboard = await NicknameHelper.getNicknameKeyboard();
  await ctx.editMessageText('Who should be credited for this post?', {
    reply_markup: keyboard,
  });
  return false; // Manual selection needed
}
```

### Media Group Forwarding with forwardMessages
For media groups (albums), use `forwardMessages` (plural) API to preserve album grouping:
```typescript
// Store all message IDs when buffering media group
const forwardInfo = parseForwardInfo(primaryMessage);
if (forwardInfo && messages.length > 1) {
  forwardInfo.mediaGroupMessageIds = messages.map((msg) => msg.message_id);
}

// In post publisher, forward entire album atomically
if (post.originalForward.mediaGroupMessageIds && post.originalForward.mediaGroupMessageIds.length > 1) {
  // Use forwardMessages (plural) to preserve album grouping
  const result = (await this.api.raw.forwardMessages({
    chat_id: post.targetChannelId,
    from_chat_id: post.originalForward.chatId,
    message_ids: post.originalForward.mediaGroupMessageIds,
  })) as any;

  return result[0].message_id;
}
```

### Setting Command Hints
Command hints appear in Telegram when users type "/". Configure in `src/index.ts` after bot initialization:
```typescript
await bot.api.setMyCommands([
  { command: 'start', description: 'Show welcome message' },
  { command: 'help', description: 'Show help and available commands' },
  { command: 'addchannel', description: 'Add a new posting channel' },
  // ... other commands
]);
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

### ❌ Don't use .on('message:text') without filtering
Using `.on('message:text')` without `.filter()` will catch ALL text messages, including custom text replies, preventing them from being processed correctly:
```typescript
// WRONG - Catches all text messages
bot.on('message:text', async (ctx: Context) => {
  // This catches forwarded text AND custom text input
});

// CORRECT - Only catch replies for custom text input
bot.on('message:text').filter((ctx) => !!ctx.message?.reply_to_message, async (ctx: Context) => {
  // This only catches replies to bot messages
});
```

### ❌ Don't skip idempotency checks during deployments
Render's zero-downtime deployments briefly run two instances simultaneously. Without idempotency checks, messages get processed twice:
```typescript
// WRONG - No check for duplicate processing
async function processSingleMessage(ctx: Context, message: Message) {
  // Immediately process without checking if already handled
}

// CORRECT - Check if message already has a session
const existingSession = await sessionSvc.findByMessage(ctx.from.id, message.message_id);
if (existingSession) {
  return; // Skip duplicate processing
}
```

### ❌ Don't use forwardMessage (singular) for media groups
For albums/media groups, use `forwardMessages` (plural) to preserve grouping. Using `forwardMessage` will only forward the first item:
```typescript
// WRONG - Only forwards first image
await this.api.forwardMessage(channelId, chatId, messageId);

// CORRECT - Forwards entire album
await this.api.raw.forwardMessages({
  chat_id: channelId,
  from_chat_id: chatId,
  message_ids: mediaGroupMessageIds, // Array of all message IDs
});
```

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

### Keeping Render Free Tier Awake

**Problem:** Render free tier spins down services after 15 minutes of inactivity. Since the bot uses webhooks (not polling), there may be no HTTP traffic for hours, causing the service to sleep and miss scheduled posts.

**Solution:** Use **cron-job.org** (free external service) to ping the health endpoint regularly:

1. **Create account at cron-job.org** (free, no credit card required)

2. **Create new cron job:**
   - **Title:** "Keep Render Bot Awake"
   - **URL:** `https://your-app.onrender.com/health`
   - **Schedule:** `*/10 * * * *` (every 10 minutes)
   - **Method:** GET
   - **Enable:** Yes

3. **Verify health endpoint exists** in `src/index.ts`:
   ```typescript
   app.get('/health', (req, res) => {
     res.json({ status: 'ok' });
   });
   ```

4. **Bot uses continuous worker** (not HTTP-triggered):
   - Worker runs every 30 seconds checking for due posts
   - No `USE_CRON_JOB` environment variable needed
   - More reliable than HTTP-triggered approach

**Benefits:**
- ✅ Service never sleeps (pinged every 10 min)
- ✅ Posts publish on time
- ✅ Free (cron-job.org free tier allows frequent pings)
- ✅ Zero configuration changes to bot code

**Monitoring:**
- Check cron-job.org execution history for successful pings
- Render logs should never show "spinning down" message

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

- `src/index.ts` - Entry point, starts bot and worker, configures command hints
- `src/services/post-worker.service.ts` - **Critical:** Background worker that posts messages
- `src/core/posting/post-scheduler.service.ts` - Slot calculation and scheduling
- `src/core/posting/post-publisher.service.ts` - Publishes a single post (transform or forward)
- `src/services/transformer.service.ts` - Attribution logic facade
- `src/core/attribution/attribution.ts` - Attribution string building logic
- `src/core/session/session.service.ts` - Database-backed session management
- `src/core/session/session-state-machine.ts` - Session state transitions
- `src/core/queue/queue.service.ts` - Queue listing and management
- `src/core/queue/queue-preview-sender.service.ts` - Sends queue preview messages
- `src/core/preview/preview-generator.service.ts` - Generates post preview before scheduling
- `src/core/preview/preview-sender.service.ts` - Sends preview to user
- `src/core/sending/media-sender.service.ts` - Media sending abstraction
- `src/shared/di/container.ts` - DI container wiring all services together
- `src/utils/sleep-window.ts` - Sleep window feature (skip slots during configured hours)
- `src/database/models/custom-text-preset.model.ts` - Custom text presets schema
- `src/bot/handlers/callback.handler.ts` - Handles all inline button clicks
- `src/bot/handlers/forward.handler.ts` - Handles forwarded and original messages
- `src/bot/handlers/command.handler.ts` - All bot commands
- `src/utils/time-slots.ts` - Time slot calculation (hh:00:01 or hh:30:01)

## Implemented Features

- [x] Media group support (albums with multiple photos/videos via forwardMessages API)
- [x] Inline nickname selection with "No attribution" option (always shown in Transform flow)
- [x] Auto-nickname selection for known users (streamlines workflow)
- [x] Custom text feature (prepend text to posts)
- [x] Custom text presets (save and reuse text snippets via `/addpreset`)
- [x] Custom text input via filtered reply handler (prevents handler conflicts)
- [x] Multi-channel support with channel selection
- [x] Post queue management (`/queue` command with per-channel view)
- [x] Sleep window feature (no posts scheduled during configured hours, via `/sleep`)
- [x] Preview message before scheduling (shows transformed output to user)
- [x] Webhooks deployment (prevents 409 conflicts)
- [x] Idempotency checks (prevents duplicate processing during zero-downtime deployments)
- [x] True forwarding via forwardMessage (preserves "Forwarded from")
- [x] Atomic album forwarding via forwardMessages (plural) API
- [x] Non-forwarded message support (original photos, videos, documents can be scheduled)
- [x] Text message forwarding support (forwarded text posts)
- [x] User attribution for any message type (forwarded or original)
- [x] Manual nickname attribution for original content (works without forward info)
- [x] Session persistence (database-backed sessions via session-state-machine)
- [x] DI container wiring all services (src/shared/di/container.ts)
- [x] cron-job.org integration (keeps Render free tier awake for scheduled posts)
- [x] Command hints (descriptions appear when typing "/" in Telegram)

## Future Improvements

- [ ] Edit scheduled posts before they're published
- [ ] Cancel/delete scheduled posts
- [ ] Statistics dashboard
- [ ] Batch scheduling
