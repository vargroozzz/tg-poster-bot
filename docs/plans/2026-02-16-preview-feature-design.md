# Preview Feature Design

**Date:** 2026-02-16
**Status:** Approved
**Author:** Claude Sonnet 4.5

## Overview

Add a preview feature that shows users exactly what their scheduled post will look like before it's published. The preview displays the actual media (photo, video, album, etc.) with the transformed text/caption in the user's private chat, with options to Schedule or Cancel.

## Requirements

### What to Show
- **Full message replica** - exactly what will appear in the target channel
- Actual media (photos, videos, documents, animations)
- Transformed text with attribution and formatting applied
- Albums shown as grouped media (not individually)

### When to Show
- For **both** Transform and Forward actions
- After all user selections are complete (channel, action, text handling, nickname, custom text)

### Available Actions
- **✅ Schedule** - Proceed to schedule the post
- **❌ Cancel** - Delete the session and preview, start over

### Timeout Behavior
- Normal 24-hour session TTL applies
- No special preview timeout

## Architecture

### Approach

Add a new `PREVIEW` state to the existing session state machine. This provides clean separation of concerns and makes the preview step explicit in the flow.

### State Machine Changes

**Add new state:**
```typescript
export enum SessionState {
  CHANNEL_SELECT = 'channel_select',
  ACTION_SELECT = 'action_select',
  TEXT_HANDLING = 'text_handling',
  NICKNAME_SELECT = 'nickname_select',
  CUSTOM_TEXT = 'custom_text',
  PREVIEW = 'preview',        // NEW
  COMPLETED = 'completed',
}
```

**Flow transitions:**
- `CUSTOM_TEXT` → `PREVIEW` (instead of going directly to COMPLETED)
- `PREVIEW` → `COMPLETED` (when user clicks Schedule)
- `PREVIEW` → (deleted) (when user clicks Cancel)

### Updated User Flow

```
1. User forwards/sends message
2. Select channel
3. Select action (Transform/Forward)
4. [Transform only] Text handling (if message has text)
5. [Transform only] Nickname selection
6. [Transform only] Custom text (add/skip)
7. PREVIEW ← NEW (both Transform and Forward)
8. Schedule (on "✅ Schedule") or Cancel (on "❌ Cancel")
```

**Transform action:** Goes through all steps, preview shows transformed message
**Forward action:** Skips steps 4-6, preview shows original message unchanged

## Components

### New Files

**1. `src/bot/keyboards/preview-action.keyboard.ts`**
- Creates inline keyboard with "✅ Schedule" and "❌ Cancel" buttons
- Button callbacks: `preview:schedule` and `preview:cancel`

**2. `src/core/sending/media-sender.service.ts`**
- Shared service for sending media to any chat
- Methods: `sendPhoto()`, `sendVideo()`, `sendDocument()`, `sendAnimation()`, `sendMediaGroup()`, `sendText()`
- Used by both preview and publishing (DRY principle)

**3. `src/core/preview/preview-generator.service.ts`**
- Generates preview message from session data
- Retrieves session data (originalMessage, selections, etc.)
- For Transform: calls `transformerService` to apply transformations
- For Forward: uses original content as-is
- Builds `MessageContent` object ready for sending

**4. `src/core/preview/preview-sender.service.ts`**
- Uses `MediaSenderService` to send preview to user's chat
- Handles different media types
- Attaches preview action keyboard
- Returns preview message ID for tracking

### Files to Modify

**1. `src/shared/constants/flow-states.ts`**
- Add `PREVIEW` to `SessionState` enum

**2. `src/core/session/session-state-machine.ts`**
- Update `getNextState()` to transition `CUSTOM_TEXT` → `PREVIEW`
- Update `getPossibleNextStates()` to include `PREVIEW`

**3. `src/core/posting/post-publisher.service.ts`**
- Refactor: Extract media sending logic to use `MediaSenderService`
- Becomes thinner, delegates actual sending to shared service

**4. `src/bot/handlers/callback.handler.ts`**
- Add callback handler for `preview:schedule` (schedules post)
- Add callback handler for `preview:cancel` (deletes session)
- Modify custom text handler to transition to PREVIEW state instead of immediately scheduling

**5. `src/database/models/session.model.ts`**
- Add optional `previewMessageId?: number` field to track preview message

## Data Flow

### Preview Generation

```
1. User completes custom text selection (or skip)
   ↓
2. Callback handler transitions session to PREVIEW state
   ↓
3. PreviewGenerator creates preview:
   - Retrieves session data
   - For Transform: applies transformations via transformerService
   - For Forward: uses original content
   - Builds MessageContent object
   ↓
4. PreviewSender sends preview:
   - Uses MediaSenderService to send media to user's chat
   - Attaches preview action keyboard
   - Stores preview message ID in session
   ↓
5. User sees preview in their private chat
```

### Schedule Flow

```
1. User clicks "✅ Schedule"
   ↓
2. Callback handler (preview:schedule):
   - Retrieves session from DB
   - Transitions to COMPLETED state
   - Calls existing scheduling logic
   - Deletes preview message (cleanup)
   - Shows "✅ Post scheduled" confirmation
   ↓
3. Normal scheduling proceeds (unchanged)
```

### Cancel Flow

```
1. User clicks "❌ Cancel"
   ↓
2. Callback handler (preview:cancel):
   - Deletes preview message
   - Deletes session from DB
   - Shows "❌ Cancelled" confirmation
   ↓
3. User can start over by forwarding a new message
```

### Data Dependencies

Preview needs these fields from session:
- `originalMessage` - the source content
- `selectedChannel` - destination channel
- `selectedAction` - transform or forward
- `textHandling` - keep/remove/quote (transform only)
- `selectedNickname` - for attribution (transform only)
- `customText` - prepended text (transform only)
- `mediaGroupMessages` - for albums

## Error Handling

### Preview Generation Failures

**Transformation Error:**
- If `transformerService` fails → log error, notify: "⚠️ Preview generation failed. Please try again."
- Session remains in CUSTOM_TEXT state
- User can retry or cancel

**Media Access Error:**
- If original media is inaccessible (expired file_id) → notify: "⚠️ Media no longer available. Please forward again."
- Delete session
- User starts over

### Preview Sending Failures

**API Error (network, rate limit):**
- Catch error, retry once with exponential backoff
- If still fails → notify: "⚠️ Could not send preview. Try again later."
- Keep session (user can retry)

**User Chat Blocked:**
- If user blocked bot → can't send preview
- Next message from user triggers: "⚠️ Previous session incomplete. Starting fresh."
- Delete old session, allow restart

### Schedule Action Failures

**Scheduling Error (after clicking Schedule):**
- If scheduling fails → notify: "❌ Failed to schedule post."
- Log error with full context
- Keep session in PREVIEW state (user can retry)

### Session Expiry

**User doesn't respond to preview:**
- Normal 24-hour TTL applies
- MongoDB auto-deletes expired session
- Preview message remains in chat (harmless)
- Clicking expired buttons shows: "Session expired"

### API Rate Limits

**Hit rate limit during preview:**
- Wait and retry once
- If persistent → delay 30 seconds, notify: "⏳ Sending preview..."

## Testing Strategy

### Manual Testing Checklist

**Transform Action:**
1. Basic transform + preview (photo with attribution)
2. All transformations (Keep/Remove/Quote text, nickname variations, custom text)
3. All media types (Photo, Video, Document, Animation, Text-only)
4. Media groups (albums with 2+ items)

**Forward Action:**
5. Forward + preview (shows original unchanged)

**Cancel:**
6. Cancel from preview (deletes session and preview message)

**Error Cases:**
7. Preview generation fails (error message shown)
8. Session expiry (expired message when clicking buttons)

**Edge Cases:**
9. Original content with manual nickname
10. Green-listed channel (skips to preview immediately)

## Implementation Notes

### Code Reuse

Extract media sending logic from `PostPublisherService` into shared `MediaSenderService`. This avoids duplication between preview and publishing, ensures consistency, and provides single source of truth for media sending.

### State Machine Integration

The new PREVIEW state integrates naturally with the existing state machine. All transitions are explicit and trackable, making debugging easier.

### Cleanup

Preview messages are deleted when:
- User clicks Schedule (after successful scheduling)
- User clicks Cancel
- Session expires (message remains but buttons become inactive)

### Performance

Previews are sent immediately (not queued), so users get instant feedback. This uses one additional API call per preview but provides much better UX.

## Future Enhancements (Out of Scope)

- Edit button to go back and modify selections
- Preview history (show last N previews)
- Preview scheduling time in the preview message
- Side-by-side comparison for Transform action

## Success Criteria

- Users can see exactly what their post will look like before scheduling
- Preview works for all media types (single and albums)
- Transform and Forward actions both show previews
- Schedule button successfully schedules the post
- Cancel button properly cleans up session and preview
- Error cases are handled gracefully with clear user feedback
