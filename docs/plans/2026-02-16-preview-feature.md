# Preview Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add preview step showing users exactly what their scheduled post will look like before publishing, with Schedule or Cancel options.

**Architecture:** Add PREVIEW state to session state machine. Extract media sending logic into shared MediaSenderService. Create PreviewGenerator and PreviewSender services. Update callback handlers to show preview after custom text selection.

**Tech Stack:** TypeScript, Grammy (Telegram Bot), MongoDB/Mongoose, existing state machine

---

## Task 1: Add PREVIEW State to State Machine

**Files:**
- Modify: `src/shared/constants/flow-states.ts:5-12`

**Step 1: Add PREVIEW state to enum**

Open `src/shared/constants/flow-states.ts` and add the new state:

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

**Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 3: Commit**

```bash
git add src/shared/constants/flow-states.ts
git commit -m "feat: add PREVIEW state to SessionState enum"
```

---

## Task 2: Update State Machine Transitions

**Files:**
- Modify: `src/core/session/session-state-machine.ts:11-54`
- Modify: `src/core/session/session-state-machine.ts:67-84`

**Step 1: Update getNextState() for CUSTOM_TEXT → PREVIEW transition**

In `src/core/session/session-state-machine.ts`, change line 43-45:

```typescript
case SessionState.CUSTOM_TEXT:
  // After custom text decision, show preview
  return SessionState.PREVIEW;
```

**Step 2: Add PREVIEW → COMPLETED transition**

Add new case after CUSTOM_TEXT:

```typescript
case SessionState.PREVIEW:
  // After preview approval, we're done
  return SessionState.COMPLETED;
```

**Step 3: Update getPossibleNextStates() to include PREVIEW**

Update the CUSTOM_TEXT case (around line 77):

```typescript
case SessionState.CUSTOM_TEXT:
  return [SessionState.PREVIEW];
```

Add new PREVIEW case:

```typescript
case SessionState.PREVIEW:
  return [SessionState.COMPLETED];
```

**Step 4: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add src/core/session/session-state-machine.ts
git commit -m "feat: update state machine for PREVIEW transitions

- CUSTOM_TEXT now transitions to PREVIEW (not COMPLETED)
- PREVIEW transitions to COMPLETED
- Update getPossibleNextStates() accordingly"
```

---

## Task 3: Create Preview Action Keyboard

**Files:**
- Create: `src/bot/keyboards/preview-action.keyboard.ts`

**Step 1: Create keyboard file**

Create `src/bot/keyboards/preview-action.keyboard.ts`:

```typescript
import { InlineKeyboard } from 'grammy';

/**
 * Creates keyboard for preview actions
 * User can schedule the post or cancel
 */
export function createPreviewActionKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard.text('✅ Schedule', 'preview:schedule');
  keyboard.text('❌ Cancel', 'preview:cancel');

  return keyboard;
}
```

**Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/bot/keyboards/preview-action.keyboard.ts
git commit -m "feat: create preview action keyboard

Provides Schedule and Cancel buttons for preview step"
```

---

## Task 4: Add previewMessageId to Session Model

**Files:**
- Modify: `src/database/models/session.model.ts:8-23`

**Step 1: Add previewMessageId field to interface**

In `src/database/models/session.model.ts`, add to ISession interface (around line 19):

```typescript
export interface ISession extends Document {
  userId: number;
  messageId: number;
  chatId: number;
  state: string;
  originalMessage: Message;
  selectedChannel?: string;
  selectedAction?: 'transform' | 'forward';
  textHandling?: 'keep' | 'remove' | 'quote';
  selectedNickname?: string | null;
  customText?: string;
  waitingForCustomText?: boolean;
  mediaGroupMessages?: Message[];
  previewMessageId?: number;  // NEW - tracks preview message for cleanup
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}
```

**Step 2: Add to schema (optional field)**

Around line 68, after mediaGroupMessages:

```typescript
  mediaGroupMessages: {
    type: Schema.Types.Mixed,
  },
  previewMessageId: {
    type: Number,
    required: false,
  },
```

**Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/database/models/session.model.ts
git commit -m "feat: add previewMessageId to session model

Tracks preview message ID for cleanup when scheduling or cancelling"
```

---

## Task 5: Create MediaSenderService

**Files:**
- Create: `src/core/sending/media-sender.service.ts`

**Step 1: Create directory**

Run: `mkdir -p src/core/sending`

**Step 2: Create MediaSenderService**

Create `src/core/sending/media-sender.service.ts`:

```typescript
import { Api } from 'grammy';
import type { MessageContent, MediaGroupItem } from '../../types/message.types.js';
import { logger } from '../../utils/logger.js';

/**
 * Shared service for sending media to Telegram
 * Used by both preview and publishing to avoid code duplication
 */
export class MediaSenderService {
  constructor(private api: Api) {}

  /**
   * Send message based on content type
   * Returns the Telegram message ID
   */
  async sendMessage(chatId: number | string, content: MessageContent): Promise<number> {
    switch (content.type) {
      case 'photo':
        return await this.sendPhoto(chatId, content.fileId!, content.text);
      case 'video':
        return await this.sendVideo(chatId, content.fileId!, content.text);
      case 'document':
        return await this.sendDocument(chatId, content.fileId!, content.text);
      case 'animation':
        return await this.sendAnimation(chatId, content.fileId!, content.text);
      case 'media_group':
        return await this.sendMediaGroup(chatId, content.mediaGroup!, content.text);
      case 'text':
        return await this.sendText(chatId, content.text!);
      default:
        throw new Error(`Unsupported content type: ${(content as any).type}`);
    }
  }

  /**
   * Send a photo message
   */
  async sendPhoto(chatId: number | string, fileId: string, caption?: string): Promise<number> {
    const result = await this.api.sendPhoto(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
    });
    return result.message_id;
  }

  /**
   * Send a video message
   */
  async sendVideo(chatId: number | string, fileId: string, caption?: string): Promise<number> {
    const result = await this.api.sendVideo(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
    });
    return result.message_id;
  }

  /**
   * Send a document message
   */
  async sendDocument(chatId: number | string, fileId: string, caption?: string): Promise<number> {
    const result = await this.api.sendDocument(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
    });
    return result.message_id;
  }

  /**
   * Send an animation (GIF) message
   */
  async sendAnimation(chatId: number | string, fileId: string, caption?: string): Promise<number> {
    const result = await this.api.sendAnimation(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
    });
    return result.message_id;
  }

  /**
   * Send a text-only message
   */
  async sendText(chatId: number | string, text: string): Promise<number> {
    const result = await this.api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
    });
    return result.message_id;
  }

  /**
   * Send a media group (album)
   */
  async sendMediaGroup(
    chatId: number | string,
    mediaGroup: MediaGroupItem[],
    caption?: string
  ): Promise<number> {
    if (!mediaGroup || mediaGroup.length === 0) {
      throw new Error('Media group cannot be empty');
    }

    // Build media array for sendMediaGroup
    const media = mediaGroup.map((item: MediaGroupItem, index: number) => {
      const baseMedia = {
        media: item.fileId,
        // Only first item gets caption
        caption: index === 0 ? caption : undefined,
        parse_mode: index === 0 ? ('HTML' as const) : undefined,
      };

      if (item.type === 'photo') {
        return { type: 'photo' as const, ...baseMedia };
      } else {
        return { type: 'video' as const, ...baseMedia };
      }
    });

    const result = await this.api.sendMediaGroup(chatId, media);
    return result[0].message_id;
  }
}
```

**Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/core/sending/media-sender.service.ts
git commit -m "feat: create MediaSenderService for shared media sending

Extracts media sending logic into shared service used by both
preview and publishing. Supports all media types including albums."
```

---

## Task 6: Refactor PostPublisherService to Use MediaSenderService

**Files:**
- Modify: `src/core/posting/post-publisher.service.ts`

**Step 1: Import MediaSenderService**

At the top of `src/core/posting/post-publisher.service.ts`:

```typescript
import { Api } from 'grammy';
import type { IScheduledPost } from '../../database/models/scheduled-post.model.js';
import { MediaSenderService } from '../sending/media-sender.service.js';  // NEW
```

**Step 2: Add MediaSenderService to constructor**

```typescript
export class PostPublisherService {
  private mediaSender: MediaSenderService;  // NEW

  constructor(private api: Api) {
    this.mediaSender = new MediaSenderService(api);  // NEW
  }
```

**Step 3: Replace publish() method to use MediaSenderService**

Replace the entire publish() method and all individual send methods (publishPhoto, publishVideo, etc.) with:

```typescript
  /**
   * Publish a post to Telegram based on its content type
   * Returns the Telegram message ID of the published message
   */
  async publish(post: IScheduledPost): Promise<number> {
    // For 'forward' action, use forwardMessage to preserve "Forwarded from" attribution
    if (post.action === 'forward') {
      return await this.copyMessage(post);
    }

    // For 'transform' action, use MediaSenderService to send
    return await this.mediaSender.sendMessage(post.targetChannelId, post.content);
  }
```

**Step 4: Delete old individual send methods**

Remove these methods (they're now in MediaSenderService):
- `publishPhoto()`
- `publishVideo()`
- `publishDocument()`
- `publishAnimation()`
- `publishText()`
- `publishMediaGroup()`

Keep only `publish()` and `copyMessage()`.

**Step 5: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add src/core/posting/post-publisher.service.ts
git commit -m "refactor: use MediaSenderService in PostPublisherService

Delegates media sending to shared service, reducing duplication.
Keeps forwardMessage logic intact for forward action."
```

---

## Task 7: Create PreviewGeneratorService

**Files:**
- Create: `src/core/preview/preview-generator.service.ts`

**Step 1: Create directory**

Run: `mkdir -p src/core/preview`

**Step 2: Create PreviewGeneratorService**

Create `src/core/preview/preview-generator.service.ts`:

```typescript
import type { Message } from 'grammy/types';
import type { ISession } from '../../database/models/session.model.js';
import type { MessageContent } from '../../types/message.types.js';
import { transformerService } from '../../services/transformer.service.js';
import { extractMessageContent } from '../../bot/handlers/forward.handler.js';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { logger } from '../../utils/logger.js';

/**
 * Generates preview content from session data
 * Handles transformation for transform action, original content for forward action
 */
export class PreviewGeneratorService {
  /**
   * Generate preview content from session
   * @returns MessageContent ready to send
   */
  async generatePreview(session: ISession): Promise<MessageContent> {
    const originalMessage = session.originalMessage;
    const mediaGroupMessages = session.mediaGroupMessages;

    // Extract base content
    const content = extractMessageContent(originalMessage, mediaGroupMessages);
    if (!content) {
      throw new Error('Could not extract message content for preview');
    }

    // For forward action, return original content unchanged
    if (session.selectedAction === 'forward') {
      logger.debug('Preview: Forward action, using original content');
      return content;
    }

    // For transform action, apply transformations
    const forwardInfo = parseForwardInfo(originalMessage);

    // Reconstruct mediaGroupMessageIds if needed
    if (mediaGroupMessages && mediaGroupMessages.length > 1) {
      forwardInfo.mediaGroupMessageIds = mediaGroupMessages.map((msg) => msg.message_id);
    }

    const originalText = content.text ?? '';
    const textHandling = session.textHandling ?? 'keep';
    const selectedNickname = session.selectedNickname;
    const customText = session.customText;

    // Transform text with attribution
    const transformedText = await transformerService.transformMessage(
      originalText,
      forwardInfo,
      'transform',
      textHandling,
      selectedNickname,
      customText
    );

    logger.debug('Preview: Transform action, applied transformations');

    // Return content with transformed text
    return {
      ...content,
      text: transformedText,
    };
  }
}
```

**Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/core/preview/preview-generator.service.ts
git commit -m "feat: create PreviewGeneratorService

Generates preview content from session data. Applies transformations
for transform action, uses original content for forward action."
```

---

## Task 8: Create PreviewSenderService

**Files:**
- Create: `src/core/preview/preview-sender.service.ts`

**Step 1: Create PreviewSenderService**

Create `src/core/preview/preview-sender.service.ts`:

```typescript
import { Api } from 'grammy';
import type { InlineKeyboard } from 'grammy';
import type { ISession } from '../../database/models/session.model.js';
import type { MessageContent } from '../../types/message.types.js';
import { MediaSenderService } from '../sending/media-sender.service.js';
import { createPreviewActionKeyboard } from '../../bot/keyboards/preview-action.keyboard.js';
import { logger } from '../../utils/logger.js';

/**
 * Sends preview to user's private chat
 * Attaches preview action keyboard
 */
export class PreviewSenderService {
  private mediaSender: MediaSenderService;

  constructor(private api: Api) {
    this.mediaSender = new MediaSenderService(api);
  }

  /**
   * Send preview to user's chat
   * @param userId - User's Telegram ID
   * @param content - Preview content to send
   * @param keyboard - Preview action keyboard
   * @returns Message ID of sent preview
   */
  async sendPreview(
    userId: number,
    content: MessageContent,
    keyboard: InlineKeyboard
  ): Promise<number> {
    try {
      // Send media based on content type
      // Note: For now, send without keyboard first, then edit to add keyboard
      // This is because different send methods have different keyboard support
      const messageId = await this.sendPreviewContent(userId, content);

      // Edit message to add keyboard
      await this.api.editMessageReplyMarkup(userId, messageId, {
        reply_markup: keyboard,
      });

      logger.debug(`Preview sent to user ${userId}, message ID: ${messageId}`);
      return messageId;
    } catch (error) {
      logger.error('Failed to send preview:', error);
      throw new Error('Failed to send preview. Please try again.');
    }
  }

  /**
   * Send the actual preview content based on type
   */
  private async sendPreviewContent(userId: number, content: MessageContent): Promise<number> {
    return await this.mediaSender.sendMessage(userId, content);
  }
}
```

**Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/core/preview/preview-sender.service.ts
git commit -m "feat: create PreviewSenderService

Sends preview to user's chat using MediaSenderService and attaches
preview action keyboard with Schedule/Cancel buttons."
```

---

## Task 9: Update Custom Text Handler to Show Preview

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`

**Step 1: Import preview services**

At the top of `src/bot/handlers/callback.handler.ts`, add:

```typescript
import { PreviewGeneratorService } from '../../core/preview/preview-generator.service.js';
import { PreviewSenderService } from '../../core/preview/preview-sender.service.js';
import { createPreviewActionKeyboard } from '../keyboards/preview-action.keyboard.js';
import { SessionState } from '../../shared/constants/flow-states.js';
```

**Step 2: Find the custom text callback handler**

Locate the handler: `bot.callbackQuery(/^custom_text:(add|skip)$/, async (ctx: Context) => {`

**Step 3: Replace the "skip" branch**

Find the section where `action === 'skip'` and it calls `scheduleTransformPost`. Replace that with showing preview:

```typescript
    } else {
      // Skip custom text - show preview instead of immediately scheduling
      await showPreview(ctx, originalMessage, foundKey);
    }
```

**Step 4: Add showPreview helper function**

After the custom text handler (around line 360), add:

```typescript
// Helper function to show preview
async function showPreview(ctx: Context, originalMessage: Message, sessionKey: string) {
  try {
    // Get session
    const sessionSvc = getSessionService();
    if (!sessionSvc) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    const session = await sessionSvc.findById(sessionKey);
    if (!session) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    // Generate preview content
    const previewGenerator = new PreviewGeneratorService();
    const previewContent = await previewGenerator.generatePreview(session);

    // Send preview to user's chat
    const previewSender = new PreviewSenderService(ctx.api);
    const keyboard = createPreviewActionKeyboard();
    const previewMessageId = await previewSender.sendPreview(
      ctx.from!.id,
      previewContent,
      keyboard
    );

    // Update session with preview message ID and transition to PREVIEW state
    await sessionSvc.updateState(sessionKey, SessionState.PREVIEW, {
      previewMessageId,
    });

    // Edit the flow message to indicate preview sent
    await ctx.editMessageText('👁️ Preview sent! Check your chat and click Schedule when ready.');

    logger.debug(`Preview shown for session ${sessionKey}`);
  } catch (error) {
    logger.error('Error showing preview:', error);
    await ctx.editMessageText('⚠️ Preview generation failed. Please try again.');
  }
}
```

**Step 5: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add src/bot/handlers/callback.handler.ts
git commit -m "feat: show preview after custom text selection

Replace immediate scheduling with preview step. Generates and sends
preview to user's chat with Schedule/Cancel keyboard."
```

---

## Task 10: Add Preview Schedule Handler

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`

**Step 1: Add preview:schedule callback handler**

After the custom text handler, add:

```typescript
// Handle preview schedule button
bot.callbackQuery('preview:schedule', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();

    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;
    if (!originalMessage) {
      await ctx.reply('⚠️ Could not find original message. Please try again.');
      return;
    }

    // Find session
    const { session } = await getPendingForward(
      ctx.from?.id ?? 0,
      originalMessage.message_id
    );

    if (!session) {
      await ctx.reply('⚠️ Session expired. Please forward the message again.');
      return;
    }

    const sessionKey = session._id.toString();

    // Get session service
    const sessionSvc = getSessionService();
    if (!sessionSvc) {
      await ctx.reply('⚠️ Service unavailable. Please try again.');
      return;
    }

    // Transition to COMPLETED state
    await sessionSvc.updateState(sessionKey, SessionState.COMPLETED, {});

    // Schedule the post based on action
    if (session.selectedAction === 'forward') {
      await scheduleForwardPostFromPreview(ctx, session, sessionKey);
    } else {
      await scheduleTransformPostFromPreview(ctx, session, sessionKey);
    }

    // Delete preview message (cleanup)
    if (session.previewMessageId) {
      try {
        await ctx.api.deleteMessage(ctx.from!.id, session.previewMessageId);
      } catch (error) {
        logger.warn('Could not delete preview message:', error);
      }
    }

    logger.info(`Post scheduled from preview for session ${sessionKey}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      '❌ Failed to schedule post. Please try again.',
      'Error in preview:schedule callback'
    );
  }
});
```

**Step 2: Add helper functions for scheduling**

Add these helper functions after the preview:schedule handler:

```typescript
// Schedule transform post from preview
async function scheduleTransformPostFromPreview(
  ctx: Context,
  session: ISession,
  sessionKey: string
) {
  const originalMessage = session.originalMessage;
  const selectedChannel = session.selectedChannel;
  const textHandling = session.textHandling ?? 'keep';
  const selectedNickname = session.selectedNickname;
  const customText = session.customText;
  const mediaGroupMessages = session.mediaGroupMessages;

  if (!selectedChannel) {
    await ctx.reply('❌ No channel selected.');
    return;
  }

  // Parse forward info
  const forwardInfo = parseForwardInfo(originalMessage);

  // Reconstruct mediaGroupMessageIds
  if (mediaGroupMessages && mediaGroupMessages.length > 1) {
    forwardInfo.mediaGroupMessageIds = mediaGroupMessages.map((msg) => msg.message_id);
  }

  // Extract message content
  const content = extractMessageContent(originalMessage, mediaGroupMessages);
  if (!content) {
    await ctx.reply('❌ Unsupported message type.');
    return;
  }

  // Schedule using the unified scheduler service
  const result = await postScheduler.scheduleTransformPost({
    targetChannelId: selectedChannel,
    originalMessage,
    forwardInfo,
    content,
    textHandling,
    selectedNickname,
    customText,
  });

  await ctx.reply(
    `✅ Post scheduled with transformation\n` +
      `📍 Target: ${selectedChannel}\n` +
      `📅 Scheduled for: ${formatSlotTime(result.scheduledTime)}`
  );

  // Clean up session
  const sessionSvc = getSessionService();
  if (sessionSvc) {
    await sessionSvc.complete(sessionKey);
  }
}

// Schedule forward post from preview
async function scheduleForwardPostFromPreview(
  ctx: Context,
  session: ISession,
  sessionKey: string
) {
  const originalMessage = session.originalMessage;
  const selectedChannel = session.selectedChannel;
  const mediaGroupMessages = session.mediaGroupMessages;

  if (!selectedChannel) {
    await ctx.reply('❌ No channel selected.');
    return;
  }

  // Parse forward info
  const forwardInfo = parseForwardInfo(originalMessage);

  // Reconstruct mediaGroupMessageIds
  if (mediaGroupMessages && mediaGroupMessages.length > 1) {
    forwardInfo.mediaGroupMessageIds = mediaGroupMessages.map((msg) => msg.message_id);
  }

  // Extract message content
  const content = extractMessageContent(originalMessage, mediaGroupMessages);
  if (!content) {
    await ctx.reply('❌ Unsupported message type.');
    return;
  }

  // Schedule using the unified scheduler service
  const result = await postScheduler.scheduleForwardPost({
    targetChannelId: selectedChannel,
    originalMessage,
    forwardInfo,
    content,
  });

  await ctx.reply(
    `✅ Post scheduled as-is\n` +
      `📍 Target: ${selectedChannel}\n` +
      `📅 Scheduled for: ${formatSlotTime(result.scheduledTime)}`
  );

  // Clean up session
  const sessionSvc = getSessionService();
  if (sessionSvc) {
    await sessionSvc.complete(sessionKey);
  }
}
```

**Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/bot/handlers/callback.handler.ts
git commit -m "feat: implement preview:schedule handler

When user clicks Schedule, transitions to COMPLETED state, schedules
the post, cleans up preview message and session."
```

---

## Task 11: Add Preview Cancel Handler

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`

**Step 1: Add preview:cancel callback handler**

After the preview:schedule handler, add:

```typescript
// Handle preview cancel button
bot.callbackQuery('preview:cancel', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();

    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;
    if (!originalMessage) {
      await ctx.reply('⚠️ Could not find original message.');
      return;
    }

    // Find session
    const { session } = await getPendingForward(
      ctx.from?.id ?? 0,
      originalMessage.message_id
    );

    if (!session) {
      await ctx.reply('⚠️ Session already expired or cancelled.');
      return;
    }

    const sessionKey = session._id.toString();

    // Delete preview message
    if (session.previewMessageId) {
      try {
        await ctx.api.deleteMessage(ctx.from!.id, session.previewMessageId);
      } catch (error) {
        logger.warn('Could not delete preview message:', error);
      }
    }

    // Delete session
    const sessionSvc = getSessionService();
    if (sessionSvc) {
      await sessionSvc.delete(sessionKey);
    }

    await ctx.reply('❌ Preview cancelled. You can start over by forwarding a new message.');

    logger.info(`Preview cancelled for session ${sessionKey}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(
      ctx,
      error,
      '⚠️ Error cancelling preview.',
      'Error in preview:cancel callback'
    );
  }
});
```

**Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/bot/handlers/callback.handler.ts
git commit -m "feat: implement preview:cancel handler

Deletes preview message and session when user clicks Cancel.
Allows user to start over with new message."
```

---

## Task 12: Update Forward Action Handler to Show Preview

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`

**Step 1: Find the forward action handler**

Locate: `bot.callbackQuery('action:forward', async (ctx: Context) => {`

**Step 2: Replace immediate scheduling with preview**

Find where it calls the scheduling function (near the end of the handler). Replace the scheduling logic with a call to `showPreview()`:

```typescript
    // Show preview instead of immediately scheduling
    await showPreview(ctx, originalMessage, foundKey);
```

Remove the existing scheduling code and confirmation message.

**Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/bot/handlers/callback.handler.ts
git commit -m "feat: show preview for forward action

Forward action now shows preview before scheduling, consistent
with transform action flow."
```

---

## Task 13: Manual Testing

**Manual Testing Checklist:**

**Test 1: Transform with Preview (Photo)**
1. Forward a photo from a channel to the bot
2. Select a posting channel
3. Select "Transform"
4. Select "Keep text"
5. Select a nickname
6. Select "Skip" custom text
7. **Verify:** Preview appears in your chat showing the photo with attribution
8. Click "✅ Schedule"
9. **Verify:** Post is scheduled, confirmation message shows
10. **Verify:** Preview message is deleted

**Test 2: Forward with Preview**
1. Forward a message to the bot
2. Select a posting channel
3. Select "Forward"
4. **Verify:** Preview appears showing original message unchanged
5. Click "✅ Schedule"
6. **Verify:** Post is scheduled for forwarding

**Test 3: Cancel Preview**
1. Start scheduling flow
2. Get to preview
3. Click "❌ Cancel"
4. **Verify:** Preview message deleted
5. **Verify:** Can start new flow by forwarding another message

**Test 4: Media Group (Album)**
1. Forward an album (2+ photos)
2. Complete the flow
3. **Verify:** Preview shows all photos grouped together
4. Schedule and verify it posts as an album

**Test 5: Custom Text**
1. Start flow
2. Select "Add custom text"
3. Reply with text
4. **Verify:** Preview shows custom text prepended
5. Schedule successfully

**Test 6: Build Verification**

Run: `npm run build`
Expected: No TypeScript errors

Run: `npm start` (in development)
Expected: Bot starts successfully, no runtime errors

**Note:** Since this project doesn't have automated tests, these manual tests are critical. Test each scenario thoroughly before considering the feature complete.

---

## Final Commit

After all manual tests pass:

```bash
git add -A
git commit -m "feat: preview feature complete

All preview functionality implemented and manually tested:
- Preview shown for both Transform and Forward actions
- Schedule button schedules the post
- Cancel button cleans up session and preview
- All media types supported (photo, video, document, animation, album, text)
- Error handling in place

Manual testing checklist completed successfully."
```

---

## Deployment Notes

**Before deploying to production:**

1. Test all flows in development environment
2. Verify MongoDB session TTL still works (24 hours)
3. Test with real Telegram channels (not just test channels)
4. Verify preview messages are cleaned up properly
5. Check Render logs for any errors during preview flow

**After deployment:**

1. Monitor logs for preview-related errors
2. Watch for any API rate limit issues (preview adds one extra API call)
3. User feedback on preview UX

---

## Success Criteria Checklist

- [ ] Preview appears after custom text selection for Transform action
- [ ] Preview appears after action selection for Forward action
- [ ] Preview shows exact replica of what will be posted
- [ ] Albums preview as grouped media (not individual items)
- [ ] Schedule button successfully schedules the post
- [ ] Cancel button deletes preview and session
- [ ] Preview message is cleaned up after scheduling
- [ ] All media types work (photo, video, document, animation, album, text)
- [ ] Error messages are clear when preview fails
- [ ] Build passes with no TypeScript errors
- [ ] Manual testing checklist complete
