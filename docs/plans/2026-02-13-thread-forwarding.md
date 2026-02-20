# Thread Forwarding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable forwarding of reply chains (message → reply → reply) to channels preserving thread structure

**Architecture:** Reply chain buffering in forward.handler.ts (1-second timeout), forwardMessages API for preview and posting, session storage for chain messages

**Tech Stack:** Grammy Bot, TypeScript, MongoDB (session model), Telegram forwardMessages API

---

## Task 1: Add Data Model Fields

**Files:**
- Modify: `src/database/models/session.model.ts`
- Modify: `src/types/message.types.ts`

### Step 1: Add replyChainMessages and previewMessageIds to session schema

In `src/database/models/session.model.ts`, add new optional fields after `mediaGroupMessages`:

```typescript
export interface ISession extends Document {
  userId: number;
  originalMessage: Message;
  selectedChannel?: string;
  selectedAction?: 'transform' | 'forward';
  textHandling?: TextHandling;
  selectedNickname?: string;
  customText?: string;
  waitingForCustomText?: boolean;
  mediaGroupMessages?: Message[];
  replyChainMessages?: Message[];     // NEW: All messages in the thread
  previewMessageId?: number;
  previewMessageIds?: number[];        // NEW: Multiple preview messages for cleanup
  state: SessionState;
  createdAt: Date;
  updatedAt: Date;
}
```

### Step 2: Add replyChainMessageIds to ForwardInfo type

In `src/types/message.types.ts`, add new optional field after `mediaGroupMessageIds`:

```typescript
export interface ForwardInfo {
  chatId: string;
  messageId: number;
  fromChannelId?: string;
  fromChannelTitle?: string;
  fromChannelUsername?: string;
  fromUserId?: number;
  fromUserFirstName?: string;
  fromUserLastName?: string;
  fromUserUsername?: string;
  messageLink?: string;
  mediaGroupMessageIds?: number[];
  replyChainMessageIds?: number[];    // NEW: For reply chains
}
```

### Step 3: Build and verify

Run:
```bash
npm run build
```

Expected: No TypeScript errors

### Step 4: Commit

```bash
git add src/database/models/session.model.ts src/types/message.types.ts
git commit -m "feat: add session fields for reply chain support

- Add replyChainMessages array to session model
- Add previewMessageIds array for multiple preview cleanup
- Add replyChainMessageIds to ForwardInfo type

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Implement Reply Chain Buffering

**Files:**
- Modify: `src/bot/handlers/forward.handler.ts:36-208`

### Step 1: Add ReplyChainBuffer interface

In `forward.handler.ts` after `MediaGroupBuffer` interface (around line 41):

```typescript
interface MediaGroupBuffer {
  messages: Message[];
  timeout: NodeJS.Timeout;
}

// NEW: Reply chain buffer interface
interface ReplyChainBuffer {
  messages: Message[];
  timeout: NodeJS.Timeout;
}
```

### Step 2: Add replyChainBuffers Map

After `mediaGroupBuffers` declaration (around line 43):

```typescript
const mediaGroupBuffers = new Map<string, MediaGroupBuffer>();
const replyChainBuffers = new Map<string, ReplyChainBuffer>();  // NEW
```

### Step 3: Add reply chain detection logic in message handler

In the message handler `bot.on([...])`, after media group buffering logic (around line 200), add reply chain detection:

```typescript
    // Single message (not part of media group)
    await processSingleMessage(ctx, message);
  } catch (error) {
```

Replace the `processSingleMessage` call section with:

```typescript
    // Single message (not part of media group)
    // Check if this could be part of a reply chain
    const replyToMessageId = 'reply_to_message' in message ? message.reply_to_message?.message_id : undefined;
    const messageId = message.message_id;
    const chatId = message.chat.id;

    // Look for existing buffer with this message or its parent
    let bufferKey: string | undefined;
    for (const [key, buffer] of replyChainBuffers.entries()) {
      for (const bufferedMsg of buffer.messages) {
        // This message replies to a buffered message, OR a buffered message replies to this one
        if (bufferedMsg.message_id === replyToMessageId ||
            ('reply_to_message' in bufferedMsg && bufferedMsg.reply_to_message?.message_id === messageId)) {
          bufferKey = key;
          break;
        }
      }
      if (bufferKey) break;
    }

    if (bufferKey) {
      // Add to existing buffer
      const buffer = replyChainBuffers.get(bufferKey)!;
      buffer.messages.push(message);
      clearTimeout(buffer.timeout);
      buffer.timeout = setTimeout(() => {
        processReplyChain(bufferKey!).catch((error) => {
          logger.error('Error processing reply chain:', error);
        });
      }, 1000);
    } else {
      // Check if this message has a reply relationship (could be start of chain)
      if (replyToMessageId) {
        // Start new buffer
        const newBufferKey = `${chatId}_${messageId}_${Date.now()}`;
        const timeout = setTimeout(() => {
          processReplyChain(newBufferKey).catch((error) => {
            logger.error('Error processing reply chain:', error);
          });
        }, 1000);

        replyChainBuffers.set(newBufferKey, {
          messages: [message],
          timeout,
        });
      } else {
        // Single message, no reply chain
        await processSingleMessage(ctx, message);
      }
    }
  } catch (error) {
```

### Step 4: Add processReplyChain function

After `processMediaGroup` function (around line 370), add:

```typescript
async function processReplyChain(bufferKey: string) {
  const buffer = replyChainBuffers.get(bufferKey);

  if (!buffer) {
    return;
  }

  // Clean up buffer
  clearTimeout(buffer.timeout);
  replyChainBuffers.delete(bufferKey);

  const messages = buffer.messages;

  if (messages.length === 0) {
    return;
  }

  // If only one message, treat as single message (not a chain)
  if (messages.length === 1) {
    // Create a fake context for processSingleMessage
    const message = messages[0];
    const fakeCtx = {
      message,
      from: message.from,
      reply: async (text: string, options?: any) => {
        await bot.api.sendMessage(message.chat.id, text, options);
      },
    } as any;
    await processSingleMessage(fakeCtx, message);
    return;
  }

  // Sort messages by message_id to get chronological order
  messages.sort((a, b) => a.message_id - b.message_id);

  // Use the first message as the primary message
  const primaryMessage = messages[0];

  // Get available posting channels
  const postingChannels = await getActivePostingChannels();

  if (postingChannels.length === 0) {
    await bot.api.sendMessage(
      primaryMessage.chat.id,
      '⚠️ No posting channels configured.\n\n' +
        'Please add channels first using /addchannel command.\n' +
        'Example: /addchannel -1001234567890'
    );
    return;
  }

  // Parse forward information from primary message
  const forwardInfo = parseForwardInfo(primaryMessage);

  // For reply chains, we always use forward action (no transform in v1)
  // Store all message IDs for proper forwarding
  if (forwardInfo && messages.length > 1) {
    forwardInfo.replyChainMessageIds = messages.map((msg) => msg.message_id);
  }

  // Check if from a green-listed channel
  const shouldAutoForward = await transformerService.shouldAutoForward(forwardInfo);

  // Create channel selection keyboard
  const channels = postingChannels.map((ch) => ({
    id: ch.channelId,
    title: ch.channelTitle ?? ch.channelId,
    username: ch.channelUsername,
  }));

  const keyboard = createChannelSelectKeyboard(channels);

  // DUAL WRITE: Store in both Map (legacy) and Database (new)
  const callbackKey = `${primaryMessage.from?.id}_${primaryMessage.message_id}_${Date.now()}`;
  pendingForwards.set(callbackKey, {
    message: primaryMessage,
    replyChainMessages: messages,
    timestamp: Date.now(),
  });

  // Also write to database for session persistence
  const sessionSvc = getSessionService();
  if (sessionSvc && primaryMessage.from?.id) {
    try {
      const session = await sessionSvc.create(primaryMessage.from.id, primaryMessage);
      // Store reply chain messages in session
      await sessionSvc.update(session._id.toString(), {
        replyChainMessages: messages,
        selectedAction: 'forward',  // Reply chains always use forward action
      });
      logger.debug(`Session created in DB for reply chain ${primaryMessage.message_id}`);
    } catch (error) {
      logger.error('Failed to create session in DB, using Map fallback:', error);
    }
  }

  const greenListNote = shouldAutoForward
    ? '\n\n🟢 This is from a green-listed channel - will be forwarded as-is.'
    : '';

  await bot.api.sendMessage(
    primaryMessage.chat.id,
    `📍 Select target channel for this thread (${messages.length} messages):${greenListNote}`,
    {
      reply_markup: keyboard,
      reply_to_message_id: primaryMessage.message_id,
    }
  );
}
```

### Step 5: Update PendingForward type

In `src/shared/helpers/pending-forward-finder.ts`, add `replyChainMessages` field:

```typescript
export interface PendingForward {
  message: Message;
  mediaGroupMessages?: Message[];
  replyChainMessages?: Message[];  // NEW
  selectedChannel?: string;
  textHandling?: TextHandling;
  selectedNickname?: string;
  customText?: string;
  waitingForCustomText?: boolean;
  timestamp: number;
}
```

### Step 6: Build and verify

Run:
```bash
npm run build
```

Expected: No TypeScript errors

### Step 7: Commit

```bash
git add src/bot/handlers/forward.handler.ts src/shared/helpers/pending-forward-finder.ts
git commit -m "feat: implement reply chain buffering and detection

- Add ReplyChainBuffer interface and map
- Detect messages with reply relationships within 1 second
- Group into chains, process as single flow
- Store replyChainMessageIds in ForwardInfo
- Always use forward action for reply chains

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Update PreviewSenderService for forwardMessages

**Files:**
- Modify: `src/core/preview/preview-sender.service.ts:1-50`

### Step 1: Modify sendPreview to use forwardMessage(s) for forward action

Replace the `sendPreview` method:

```typescript
  /**
   * Send preview to user's private chat
   * Returns the control message ID (the message with Schedule/Cancel buttons)
   *
   * For forward action: Uses api.forwardMessage(s) to show actual "Forwarded from" attribution
   * For transform action: Uses MediaSenderService to show transformed content
   */
  async sendPreview(
    userId: number,
    content: MessageContent,
    sessionId: string
  ): Promise<number> {
    // Import SessionService to check session details
    const { DIContainer } = await import('../../shared/di/container.js');
    const SessionService = DIContainer.resolve<any>('SessionService');

    let previewMessageIds: number[] = [];

    // Check if this is a forward action
    const session = await SessionService.findById(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const isForward = session.selectedAction === 'forward';

    if (isForward) {
      // For forward action, use forwardMessage(s) to show "Forwarded from" attribution
      const originalMessage = session.originalMessage;
      const chatId = originalMessage.chat.id;

      // Check if this is a reply chain
      if (session.replyChainMessages && session.replyChainMessages.length > 1) {
        // Forward all messages in the chain
        const messageIds = session.replyChainMessages.map((msg: any) => msg.message_id);

        try {
          const result = (await this.api.raw.forwardMessages({
            chat_id: userId,
            from_chat_id: chatId,
            message_ids: messageIds,
          })) as any;

          // result is array of MessageId objects
          previewMessageIds = result.map((r: any) => r.message_id);
        } catch (error) {
          // Fallback to text preview if forwardMessages fails
          const fallbackContent: MessageContent = {
            type: 'text',
            text: `🧵 Thread of ${messageIds.length} messages will be forwarded (preview unavailable)`,
          };
          const fallbackMsgId = await this.mediaSender.sendMessage(userId, fallbackContent);
          previewMessageIds = [fallbackMsgId];
        }
      } else if (session.mediaGroupMessages && session.mediaGroupMessages.length > 1) {
        // Forward media group
        const messageIds = session.mediaGroupMessages.map((msg: any) => msg.message_id);
        const result = (await this.api.raw.forwardMessages({
          chat_id: userId,
          from_chat_id: chatId,
          message_ids: messageIds,
        })) as any;

        previewMessageIds = result.map((r: any) => r.message_id);
      } else {
        // Forward single message
        const result = await this.api.forwardMessage(
          userId,
          chatId,
          originalMessage.message_id
        );
        previewMessageIds = [result.message_id];
      }

      // Store preview message IDs in session for cleanup
      await SessionService.update(sessionId, { previewMessageIds });
    } else {
      // For transform action, send transformed content via MediaSenderService
      const previewMsgId = await this.mediaSender.sendMessage(userId, content);
      previewMessageIds = [previewMsgId];

      // Store single preview message ID (backward compatible)
      await SessionService.update(sessionId, {
        previewMessageId: previewMsgId,
        previewMessageIds
      });
    }

    // Send control message with keyboard
    const keyboard = createPreviewActionKeyboard(sessionId);
    const controlMessage = await this.api.sendMessage(
      userId,
      '👁️ Preview above. What would you like to do?',
      { reply_markup: keyboard }
    );

    return controlMessage.message_id;
  }
```

### Step 2: Build and verify

Run:
```bash
npm run build
```

Expected: No TypeScript errors

### Step 3: Commit

```bash
git add src/core/preview/preview-sender.service.ts
git commit -m "feat: use forwardMessages for forward action preview

- Show actual 'Forwarded from' attribution in preview
- Support reply chains with forwardMessages
- Support media groups with forwardMessages
- Store previewMessageIds array for cleanup
- Fallback to text preview if forwardMessages fails

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Update PreviewGeneratorService for Reply Chains

**Files:**
- Modify: `src/core/preview/preview-generator.service.ts:1-80`

### Step 1: Add reply chain handling to generatePreview

In the `generatePreview` method, add logic for reply chains before the existing media group check:

```typescript
  async generatePreview(session: ISession): Promise<MessageContent> {
    // For reply chains, return placeholder content
    // Actual preview is sent via forwardMessages in PreviewSenderService
    if (session.replyChainMessages && session.replyChainMessages.length > 1) {
      return {
        type: 'text',
        text: `🧵 Thread of ${session.replyChainMessages.length} messages (see above)`,
      };
    }

    // For media groups, return placeholder content
    // Actual preview is sent via MediaSenderService in PreviewSenderService
    if (session.mediaGroupMessages && session.mediaGroupMessages.length > 1) {
      return {
        type: 'text',
        text: `📸 Album of ${session.mediaGroupMessages.length} items (see above)`,
      };
    }
```

### Step 2: Build and verify

Run:
```bash
npm run build
```

Expected: No TypeScript errors

### Step 3: Commit

```bash
git add src/core/preview/preview-generator.service.ts
git commit -m "feat: add reply chain placeholder in preview generator

- Return placeholder text for reply chains
- Actual thread preview sent via forwardMessages
- Consistent with media group pattern

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Update PostPublisherService for Reply Chains

**Files:**
- Modify: `src/core/posting/post-publisher.service.ts:35-61`

### Step 1: Update copyMessage to handle reply chains

Replace the `copyMessage` method:

```typescript
  /**
   * Forward message using Telegram's forwardMessage(s) API
   * This preserves the "Forwarded from" attribution
   * For media groups and reply chains, forwards all messages atomically to preserve structure
   */
  private async copyMessage(post: IScheduledPost): Promise<number> {
    if (!post.originalForward.chatId || !post.originalForward.messageId) {
      throw new Error('Missing chatId or messageId for forwardMessage');
    }

    // For reply chains, use forwardMessages to preserve reply structure
    if (post.originalForward.replyChainMessageIds && post.originalForward.replyChainMessageIds.length > 1) {
      // Use raw API for forwardMessages (Grammy might not have typed wrapper)
      const result = (await this.api.raw.forwardMessages({
        chat_id: post.targetChannelId,
        from_chat_id: post.originalForward.chatId,
        message_ids: post.originalForward.replyChainMessageIds,
      })) as any;

      // Returns array of MessageId objects
      return result[0].message_id;
    }

    // For media groups, use forwardMessages to preserve album grouping
    if (post.originalForward.mediaGroupMessageIds && post.originalForward.mediaGroupMessageIds.length > 1) {
      // Use raw API for forwardMessages (Grammy might not have typed wrapper)
      const result = (await this.api.raw.forwardMessages({
        chat_id: post.targetChannelId,
        from_chat_id: post.originalForward.chatId,
        message_ids: post.originalForward.mediaGroupMessageIds,
      })) as any;

      // Returns array of MessageId objects
      return result[0].message_id;
    }

    // Single message forward
    const result = await this.api.forwardMessage(
      post.targetChannelId,
      post.originalForward.chatId,
      post.originalForward.messageId
    );

    return result.message_id;
  }
```

### Step 2: Build and verify

Run:
```bash
npm run build
```

Expected: No TypeScript errors

### Step 3: Commit

```bash
git add src/core/posting/post-publisher.service.ts
git commit -m "feat: support reply chain forwarding in post publisher

- Use forwardMessages for reply chains
- Preserve reply structure in target channel
- Handle replyChainMessageIds from ForwardInfo

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 6: Update Callback Handlers for Preview Cleanup

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts` (preview:schedule and preview:cancel handlers)

### Step 1: Update preview:schedule handler to delete array of preview messages

Find the `preview:schedule` handler (around line 400) and update the preview cleanup section:

```typescript
bot.callbackQuery(/^preview:schedule:(.+)$/, async (ctx) => {
  try {
    await ctx.answerCallbackQuery();

    const match = ctx.callbackQuery.data.match(/^preview:schedule:(.+)$/);
    if (!match) {
      await ctx.reply('❌ Invalid callback data');
      return;
    }

    const sessionId = match[1];
    const sessionSvc = getSessionService();

    if (!sessionSvc) {
      await ctx.reply('❌ Session service not available');
      return;
    }

    const session = await sessionSvc.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Session not found. It may have expired.');
      return;
    }

    // Schedule the post
    const result = await schedulePostFromSession(session, sessionId);

    await ctx.reply(
      `✅ Post scheduled\\n` +
        `📍 Target: ${session.selectedChannel}\\n` +
        `📅 Scheduled for: ${formatSlotTime(result.scheduledTime)}`,
      {
        reply_to_message_id: session.originalMessage.message_id,
      }
    );

    // Delete preview messages (array support)
    try {
      if (session.previewMessageIds && session.previewMessageIds.length > 0) {
        // Delete all preview messages
        for (const msgId of session.previewMessageIds) {
          try {
            await ctx.api.deleteMessage(ctx.from!.id, msgId);
          } catch (error) {
            logger.warn(`Failed to delete preview message ${msgId}:`, error);
          }
        }
      } else if (session.previewMessageId) {
        // Backward compatibility: single preview message
        await ctx.api.deleteMessage(ctx.from!.id, session.previewMessageId);
      }

      // Delete control message
      await ctx.deleteMessage();
    } catch (error) {
      logger.warn('Failed to delete preview messages:', error);
      // Don't fail the whole operation if cleanup fails
    }

    // Complete session
    await sessionSvc.complete(sessionId);

    logger.info(`Post scheduled from session ${sessionId} to ${session.selectedChannel}`);
  } catch (error) {
    logger.error('Error in preview:schedule handler:', error);
    await ctx.reply('❌ Error scheduling post. Please try again.');
  }
});
```

### Step 2: Update preview:cancel handler to delete array of preview messages

Find the `preview:cancel` handler and update similarly:

```typescript
bot.callbackQuery(/^preview:cancel:(.+)$/, async (ctx) => {
  try {
    await ctx.answerCallbackQuery();

    const match = ctx.callbackQuery.data.match(/^preview:cancel:(.+)$/);
    if (!match) {
      await ctx.reply('❌ Invalid callback data');
      return;
    }

    const sessionId = match[1];
    const sessionSvc = getSessionService();

    if (!sessionSvc) {
      await ctx.reply('❌ Session service not available');
      return;
    }

    const session = await sessionSvc.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Session not found. It may have expired.');
      return;
    }

    // Delete preview messages (array support)
    try {
      if (session.previewMessageIds && session.previewMessageIds.length > 0) {
        // Delete all preview messages
        for (const msgId of session.previewMessageIds) {
          try {
            await ctx.api.deleteMessage(ctx.from!.id, msgId);
          } catch (error) {
            logger.warn(`Failed to delete preview message ${msgId}:`, error);
          }
        }
      } else if (session.previewMessageId) {
        // Backward compatibility: single preview message
        await ctx.api.deleteMessage(ctx.from!.id, session.previewMessageId);
      }

      // Delete control message
      await ctx.deleteMessage();
    } catch (error) {
      logger.warn('Failed to delete preview messages:', error);
      // Continue with cancellation even if cleanup fails
    }

    await ctx.reply('❌ Preview cancelled. You can forward another message to schedule.');

    // Complete session (cancellation is completion)
    await sessionSvc.complete(sessionId);

    logger.debug(`Preview cancelled for session ${sessionId}`);
  } catch (error) {
    logger.error('Error in preview:cancel handler:', error);
    await ctx.reply('❌ Error cancelling preview. Please try again.');
  }
});
```

### Step 3: Build and verify

Run:
```bash
npm run build
```

Expected: No TypeScript errors

### Step 4: Commit

```bash
git add src/bot/handlers/callback.handler.ts
git commit -m "feat: support preview message array cleanup

- Delete all preview messages from previewMessageIds array
- Support both new array format and old single message format
- Handle cleanup errors gracefully without blocking flow

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 7: Update Channel Selection Handler for Reply Chains

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts` (channel select handler)

### Step 1: Skip action selection for reply chains

In the channel selection handler (around `bot.callbackQuery(/^channel:(.+)$/)`), add logic to skip action selection and go straight to preview for reply chains:

Find the section after channel selection is stored, where it shows action buttons. Add a check for reply chains before showing action buttons:

```typescript
    // Store selected channel
    if (sessionSvc) {
      await sessionSvc.updateState(sessionId, SessionState.ACTION_SELECT, {
        selectedChannel: channelId,
      });
    }

    // For reply chains, skip action selection (always forward)
    const session = await sessionSvc?.findById(sessionId);
    if (session?.replyChainMessages && session.replyChainMessages.length > 1) {
      // Skip to preview
      await showPreview(ctx, sessionId);
      return;
    }

    // Check if should auto-forward (existing logic)
    const shouldAutoForward = await transformerService.shouldAutoForward(forwardInfo);
```

### Step 2: Build and verify

Run:
```bash
npm run build
```

Expected: No TypeScript errors

### Step 3: Commit

```bash
git add src/bot/handlers/callback.handler.ts
git commit -m "feat: skip action selection for reply chains

- Reply chains always use forward action
- Skip directly to preview after channel selection
- Consistent with design (no transform for threads in v1)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 8: Manual Testing

**Goal:** Verify thread forwarding works end-to-end

**Prerequisites:**
- Bot running locally (`npm run dev`) or in staging
- Access to a test channel as admin
- Test Telegram account with some message threads

### Test Case 1: Basic Reply Chain (2 messages)

**Steps:**
1. In a private chat or group, send a message "Message A"
2. Reply to "Message A" with "Reply B"
3. Select both messages and forward them to the bot
4. Select a target channel
5. Wait for preview to appear
6. Verify preview shows both messages with reply structure
7. Verify "Forwarded from" attribution is visible
8. Click "Schedule"
9. Wait for scheduled time (or manually update scheduledTime in DB)
10. Check target channel

**Expected:**
- Preview shows 2 messages with reply relationship preserved
- Preview shows "Forwarded from" attribution
- Channel post has both messages with reply preserved
- Control message says "Thread of 2 messages (see above)"

### Test Case 2: Longer Chain (5 messages)

**Steps:**
1. Create a chain: A → B → C → D → E (each replies to previous)
2. Forward all 5 together to bot
3. Follow flow
4. Verify preview and final post

**Expected:**
- Preview shows all 5 messages in order with reply structure
- Channel post preserves full chain

### Test Case 3: Separate Messages (Not a Chain)

**Steps:**
1. Send message A (no reply)
2. Send message B (no reply to A)
3. Forward both together to bot

**Expected:**
- Two separate flows created (not grouped as thread)
- Each message gets its own channel selection

### Test Case 4: Green-listed Channel Thread

**Steps:**
1. Add a channel to green list: `/greenlist` (reply to message from that channel)
2. Forward a reply chain from that green-listed channel
3. Select target channel

**Expected:**
- Preview still shows (no auto-schedule for threads)
- "Forwarded from" shows green-listed channel name
- Preview and post both show thread structure

### Test Case 5: Cancel Preview

**Steps:**
1. Forward a reply chain
2. Get to preview
3. Click "Cancel"

**Expected:**
- All preview messages deleted (not just control message)
- Bot confirms cancellation
- No post scheduled

### Test Case 6: Single Message Forward (Bonus Fix)

**Steps:**
1. Forward a single message (not a chain)
2. Select channel
3. Select "Forward" action
4. View preview

**Expected:**
- Preview uses `forwardMessage` and shows "Forwarded from" attribution
- This is a fix for existing behavior (previously didn't show attribution in preview)

### Test Case 7: Mixed Timing (Timeout Test)

**Steps:**
1. Forward message A to bot
2. Wait 2 seconds
3. Forward message B (which was a reply to A in source chat) to bot

**Expected:**
- Two separate flows (timeout exceeded)
- Messages not grouped as thread

### Verification Checklist

After all test cases:

- [ ] Reply chains forwarded together are detected and grouped
- [ ] Preview shows thread with reply structure
- [ ] Preview shows "Forwarded from" attribution
- [ ] Posted threads preserve reply relationships in channel
- [ ] Single-message forwards show attribution in preview
- [ ] Separate messages create separate flows
- [ ] Green-listed channels show preview (not auto-scheduled)
- [ ] Preview cleanup deletes all messages
- [ ] No TypeScript errors in build
- [ ] No runtime errors in logs

---

## Success Criteria

- Reply chains detected automatically (1-second buffer)
- Preview accurately shows threads with "Forwarded from"
- Posted threads preserve reply structure
- Single forwards also show attribution in preview
- Two unrelated messages create separate flows
- Green-listed channels show preview for threads
- Preview cleanup handles multiple messages

## Notes

- This is v1: forward-only (no transform for threads)
- Text handling, nickname, custom text skipped for threads
- Future: Could add transform support for chains
- Future: Could add manual thread building
