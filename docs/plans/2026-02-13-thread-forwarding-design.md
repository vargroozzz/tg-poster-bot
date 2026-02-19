# Thread Forwarding Design

**Date:** 2026-02-13
**Status:** Approved
**Author:** Claude Sonnet 4.5

## Overview

Add support for forwarding reply chains (threads) from other chats to target channels. When users forward multiple messages with reply relationships together, the bot detects the chain structure and forwards them to the channel preserving the reply relationships.

## Requirements

### What Users Can Do
- Forward a reply chain (message A, reply B, reply C) from any chat to the bot
- The bot detects the chain structure automatically
- Channel selection, preview, and scheduling work the same as single messages
- The entire chain posts to the channel with reply structure preserved

### Detection Criteria
- Messages forwarded together arrive within 1 second
- Messages are grouped by `reply_to_message` relationships
- Messages with no reply relationship to each other create separate flows

### Forwarding Behavior
- Action: Always "forward" (no transform option for chains in v1)
- Preview: Uses `forwardMessages` to show actual thread with "Forwarded from" attribution
- Posting: Uses `forwardMessages` API to preserve reply structure in target channel

## Architecture

### Reply Chain Buffering

Similar to the existing `mediaGroupBuffers` in `forward.handler.ts`, add a `replyChainBuffers` mechanism:

1. When a forwarded message arrives, check if it's a reply to a message in an active buffer
2. If yes → merge into that group, reset the 1-second timeout
3. If no → start a new buffer group with 1-second timeout
4. On timeout → process the group:
   - Single message → existing flow
   - Reply chain → new thread flow (always forward action)

**Key insight:** Two unrelated messages forwarded simultaneously create separate flows because they have no `reply_to_message` relationship. Only messages with reply links are grouped.

### Preview Improvement

**For reply chains:**
- Use `forwardMessages` to forward A, B, C to user's private chat
- Shows actual content, "Forwarded from" attribution, and reply structure
- Send separate control message "What would you like to do?" with Schedule/Cancel keyboard
- Track `previewMessageIds: number[]` for cleanup

**For single-message forwards (bonus fix):**
- Change `PreviewSenderService` to use `api.forwardMessage` instead of `MediaSenderService.sendMessage` for forward action
- This shows "Forwarded from" attribution in preview (currently missing)

### Flow Changes

**Thread flow (simplified):**
```
User forwards chain → Buffer detects grouping → Channel select →
Preview (via forwardMessages) → Schedule/Cancel → Post to channel
```

**Skip these steps for threads:**
- Action selection (always forward)
- Text handling (N/A for forward)
- Nickname selection (N/A for forward)
- Custom text (N/A for forward)

**Green-listed channels:**
- Previously: auto-schedule without preview
- For threads: Show preview (same as regular channels)
- For single messages: Keep existing auto-forward behavior

## Data Changes

### Session Model (`session.model.ts`)
```typescript
export interface ISession extends Document {
  // ... existing fields
  replyChainMessages?: Message[];  // All messages in the thread
  previewMessageIds?: number[];     // Multiple preview messages for cleanup
  previewMessageId?: number;        // Keep for backward compatibility
}
```

### Message Types (`message.types.ts`)
```typescript
export interface ForwardInfo {
  // ... existing fields
  mediaGroupMessageIds?: number[];      // For albums
  replyChainMessageIds?: number[];      // NEW: For threads
}
```

### Scheduled Post Model (`scheduled-post.model.ts`)
Store `replyChainMessageIds` in `originalForward` field (already supports this via embedded `ForwardInfo` structure).

## Components

### New/Modified Files

**1. `forward.handler.ts`**
- Add `replyChainBuffers: Map<string, ReplyChainBuffer>`
- Add buffer detection logic parallel to media groups
- On buffer timeout, create session with `replyChainMessages`

**2. `session.model.ts`**
- Add `replyChainMessages?: Message[]`
- Add `previewMessageIds?: number[]`

**3. `message.types.ts`**
- Add `replyChainMessageIds?: number[]` to `ForwardInfo`

**4. `preview-sender.service.ts`**
- Modify `sendPreview()`:
  - For forward action (single or chain): use `api.forwardMessage(s)`
  - For transform action: keep existing `MediaSenderService` approach
  - Return message IDs (single number or array)

**5. `preview-generator.service.ts`**
- For chains: return placeholder `MessageContent` with text "🧵 Thread of N messages (see above)"
- This is for the control message only (actual preview uses `forwardMessages`)

**6. `post-publisher.service.ts`**
- Update `copyMessage()`:
  - Check for `replyChainMessageIds` in `originalForward`
  - If present, use `forwardMessages` with array
  - If not, use existing `forwardMessage` logic

**7. `callback.handler.ts`**
- Update `showPreview()`: handle `replyChainMessages` case
- Update `preview:schedule` handler: delete all `previewMessageIds` (array)
- Update `preview:cancel` handler: delete all `previewMessageIds` (array)

## Data Flow

```
1. User forwards reply chain (A→B→C) from source chat to bot
   ↓
2. Bot chat receives:
   - Message A (message_id=100, no reply_to_message)
   - Message B (message_id=101, reply_to_message.message_id=100)
   - Message C (message_id=102, reply_to_message.message_id=101)
   ↓
3. Reply chain buffer:
   - A arrives → start buffer, 1-second timer
   - B arrives → has reply_to_message=100 → merge into A's group, reset timer
   - C arrives → has reply_to_message=101 → merge into A's group, reset timer
   - Timer fires → group has 3 messages → detected as reply chain
   ↓
4. Session created:
   - originalMessage = A
   - replyChainMessages = [A, B, C]
   - state = CHANNEL_SELECT
   ↓
5. Bot shows channel select keyboard
   ↓
6. User selects channel → all channels (green/red/regular) show preview:
   ↓
7. Preview generation:
   - PreviewSenderService uses api.forwardMessages([100, 101, 102])
     to forward from bot.chatId to user's private chat
   - Messages appear with "Forwarded from [source]" + reply structure
   - Store previewMessageIds = [200, 201, 202] in session
   - Send control message "What would you like to do?" with keyboard
   - Store previewControlMessageId in session
   ↓
8. User clicks "Schedule":
   - PostSchedulerService saves post with:
     - originalForward.replyChainMessageIds = [100, 101, 102]
     - action = 'forward'
   - Delete preview messages [200, 201, 202] + control message
   - Transition to COMPLETED
   ↓
9. PostWorkerService publishes:
   - Calls api.forwardMessages([100, 101, 102])
     from bot.chatId to targetChannelId
   - Telegram preserves reply structure in channel
   - Mark post as 'posted'
```

## Error Handling

### Buffer Timeout Issues
If messages arrive slowly (>1 second apart), they're treated as separate flows. User can retry by forwarding together.

### Partial Chain Forwarding Failure
If `forwardMessages` fails mid-chain (API error, network issue), mark post as `failed` with error logged. Retry mechanism reuses the same `replyChainMessageIds`.

### Preview Cleanup Failure
If deleting preview messages fails (user blocked bot, messages already deleted), log warning but continue with schedule/cancel action. Don't block user flow.

### Chain Depth Limits
Telegram may have limits on reply chain depth. Accept all messages in the chain but log warnings if chain is very deep (>100 messages). No artificial limit imposed by bot.

### Mixed Content in Chain
If chain contains unsupported message types (polls, contacts, stickers), the forward action passes through to Telegram. It either succeeds or fails with Telegram's error message.

### Preview Forward Failure
If `forwardMessages` fails during preview (rare), fall back to text-only preview: "🧵 Thread of N messages will be forwarded (preview unavailable)".

## Testing Strategy

Manual testing checklist (project has no automated tests):

1. **Basic chain forward:**
   - Forward 2-message chain (A→B)
   - Verify preview shows both messages with reply structure
   - Verify "Forwarded from" attribution visible
   - Click Schedule
   - Verify channel post has both messages with reply preserved

2. **Longer chain:**
   - Forward 5-message chain
   - Same verification as above

3. **Separate messages (not a chain):**
   - Forward 2 unrelated messages simultaneously
   - Verify they create two separate flows (not grouped)

4. **Green-listed channel:**
   - Forward chain from green-listed source
   - Verify preview still shows (no auto-schedule)
   - Verify "Forwarded from" attribution shows green-listed channel

5. **Cancel preview:**
   - Forward chain, get to preview
   - Click Cancel
   - Verify all preview messages deleted

6. **Single forward message (bonus fix):**
   - Forward single message with "forward" action
   - Verify preview uses `forwardMessage` and shows "Forwarded from"
   - This is a fix for existing preview behavior

7. **Edge case - mixed timing:**
   - Forward message A
   - Wait 2 seconds
   - Forward message B (reply to A in source chat)
   - Verify they create separate flows (timeout exceeded)

## Success Criteria

- Reply chains forwarded together are detected and grouped automatically
- Preview accurately shows the thread with reply structure and "Forwarded from" attribution
- Posted threads preserve reply relationships in target channel
- Single-message forwards also benefit from improved preview accuracy
- Two unrelated messages forwarded simultaneously create separate flows
- Green-listed channels show preview for threads (not auto-scheduled)

## Out of Scope (Future Enhancements)

- Transform action for reply chains (v1 is forward-only)
- Text handling, nickname, custom text for threads
- Manual thread building (user adds messages one by one)
- Thread editing/reordering before scheduling
- Preview showing all messages inline (currently shows "Thread of N" text + forwarded messages above)
