# Reply to Scheduled Posts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user attach a reply to any scheduled post — either in the same publishing cycle ("together") or at its own future slot ("separated") — with the full scheduling flow (transform/forward, text handling, nickname, custom text, preview).

**Architecture:** Together replies are stored as an `embeddedReply` sub-document on the parent `IScheduledPost` and published atomically by the worker immediately after the parent. Separated replies are independent `IScheduledPost` documents in `status: 'waiting_parent'`; when the parent publishes, the worker fills in `replyToMessageId`/`replyToChannelId` and flips them to `'pending'`. Reply sessions use two new `SessionState` values and are intercepted in the forward handler before a new standalone session would be created.

**Tech Stack:** TypeScript, Grammy, MongoDB/Mongoose, existing session state machine and DI container.

---

## File Map

**New files:**
- `src/bot/keyboards/reply-slot.keyboard.ts` — "Same slot as parent" / "Next available slot" keyboard
- `src/bot/handlers/callbacks/reply.ts` — handles `reply_trigger:*`, `queue_reply:*`
- `src/core/session/__tests__/session-state-machine.test.ts` — tests for new state transitions
- `src/core/posting/__tests__/post-publisher-reply.test.ts` — tests for `publishEmbeddedReply`

**Modified files:**
- `src/database/models/scheduled-post.model.ts` — `EmbeddedReplyData` interface + new fields + `'waiting_parent'` status
- `src/database/models/session.model.ts` — `isReply`, `replyParentPostId`, `replyMode`
- `src/shared/constants/flow-states.ts` — two new `SessionState` values
- `src/core/session/session-state-machine.ts` — transitions for new states
- `src/database/repositories/session.repository.ts` — `findWaitingForReplyContent`
- `src/core/session/session.service.ts` — `createForReply`, `findWaitingForReplyContent`
- `src/database/repositories/scheduled-post.repository.ts` — `attachEmbeddedReply`, `convertToSeparatedReply`, `unblockSeparatedReplies`, `findOne`
- `src/bot/keyboards/preview-action.keyboard.ts` — export `createAddReplyKeyboard`
- `src/bot/keyboards/queue-preview-action.keyboard.ts` — add "💬 Add reply" button
- `src/bot/handlers/forward.handler.ts` — intercept `WAITING_FOR_REPLY_CONTENT` sessions
- `src/bot/handlers/callbacks/scheduling.ts` — channel select → reply slot; `reply_slot:*`; `preview:schedule` reply path; reply button on confirmation
- `src/bot/handlers/callbacks/index.ts` — import `registerReply`
- `src/core/posting/post-publisher.service.ts` — `publishEmbeddedReply`; `reply_parameters` in `copyMessage`
- `src/services/post-worker.service.ts` — publish embedded reply; unblock separated replies

---

### Task 1: IScheduledPost — new fields and status

**Files:**
- Modify: `src/database/models/scheduled-post.model.ts`

- [ ] **Step 1: Add `EmbeddedReplyData` interface and new fields**

Replace the entire file content with:

```typescript
import mongoose, { Schema, Document } from 'mongoose';
import type { ForwardInfo, MessageContent, TransformAction, TextHandling } from '../../types/message.types.js';

export interface RetryMetadata {
  attemptCount: number;
  lastAttemptAt?: Date;
  nextRetryAt?: Date;
  lastError?: string;
}

export interface EmbeddedReplyData {
  targetChannelId: string;
  content: MessageContent;
  rawContent?: MessageContent;
  action: TransformAction;
  textHandling?: TextHandling;
  selectedUserId?: number | null;
  customText?: string;
  originalForward: ForwardInfo;
}

export interface IScheduledPost extends Document {
  scheduledTime: Date;
  targetChannelId: string;
  telegramScheduledMessageId?: number;
  originalForward: ForwardInfo;
  content: MessageContent;
  action: TransformAction;
  rawContent?: MessageContent;
  textHandling?: TextHandling;
  selectedUserId?: number | null;
  customText?: string;
  status: 'pending' | 'posted' | 'failed' | 'waiting_parent';
  postedAt?: Date;
  error?: string;
  retryMetadata?: RetryMetadata;
  // Together reply — published atomically with this post
  embeddedReply?: EmbeddedReplyData;
  embeddedReplyError?: string;
  // Separated reply — this post is a reply to parentPostId
  parentPostId?: string;
  replyToMessageId?: number;
  replyToChannelId?: string;
  createdAt: Date;
}

const scheduledPostSchema = new Schema<IScheduledPost>({
  scheduledTime: {
    type: Date,
    required: true,
    index: true,
  },
  targetChannelId: {
    type: String,
    required: true,
  },
  telegramScheduledMessageId: {
    type: Number,
  },
  originalForward: {
    messageId: { type: Number, required: true },
    chatId: { type: Number, required: true },
    fromUserId: Number,
    fromUsername: String,
    fromChannelId: Number,
    fromChannelUsername: String,
    fromChannelTitle: String,
    messageLink: String,
    mediaGroupMessageIds: [Number],
    replyChainMessageIds: [Number],
    replyParameters: {
      chatId: Number,
      messageId: Number,
    },
  },
  content: {
    type: {
      type: String,
      enum: ['text', 'photo', 'video', 'document', 'animation', 'media_group', 'poll'],
      required: true,
    },
    text: String,
    fileId: String,
    hasSpoiler: Boolean,
    mediaGroup: [
      {
        type: {
          type: String,
          enum: ['photo', 'video'],
          required: true,
        },
        fileId: {
          type: String,
          required: true,
        },
        hasSpoiler: Boolean,
      },
    ],
    linkPreviewOptions: {
      is_disabled: Boolean,
    },
  },
  action: {
    type: String,
    enum: ['transform', 'forward'],
    required: true,
  },
  rawContent: {
    type: Schema.Types.Mixed,
  },
  textHandling: {
    type: String,
    enum: ['keep', 'remove', 'quote'],
  },
  selectedUserId: {
    type: Number,
    default: null,
  },
  customText: String,
  status: {
    type: String,
    enum: ['pending', 'posted', 'failed', 'waiting_parent'],
    default: 'pending',
    index: true,
  },
  postedAt: {
    type: Date,
  },
  error: {
    type: String,
  },
  retryMetadata: {
    attemptCount: {
      type: Number,
      default: 0,
    },
    lastAttemptAt: Date,
    nextRetryAt: Date,
    lastError: String,
  },
  embeddedReply: {
    type: Schema.Types.Mixed,
  },
  embeddedReplyError: {
    type: String,
  },
  parentPostId: {
    type: String,
    index: true,
    sparse: true,
  },
  replyToMessageId: {
    type: Number,
  },
  replyToChannelId: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Compound unique index to prevent double-booking
scheduledPostSchema.index({ scheduledTime: 1, targetChannelId: 1 }, { unique: true, sparse: true });

// Sparse index for usage-count aggregation in nickname keyboard
scheduledPostSchema.index({ selectedUserId: 1 }, { sparse: true });

export const ScheduledPost = mongoose.model<IScheduledPost>(
  'ScheduledPost',
  scheduledPostSchema
);
```

- [ ] **Step 2: Verify build passes**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build 2>&1 | head -40
```

Expected: no errors related to this file.

- [ ] **Step 3: Commit**

```bash
git add src/database/models/scheduled-post.model.ts
git commit -m "feat: add embedded reply and separated reply fields to IScheduledPost"
```

---

### Task 2: ISession — reply fields and new SessionState values

**Files:**
- Modify: `src/database/models/session.model.ts`
- Modify: `src/shared/constants/flow-states.ts`

- [ ] **Step 1: Add reply fields to `ISession`**

In `src/database/models/session.model.ts`, add three fields to the `ISession` interface (after `editingOriginalForward`):

```typescript
  isReply?: boolean;
  replyParentPostId?: string;
  replyMode?: 'together' | 'separated';
```

And add the corresponding schema fields (after `editingOriginalForward` schema field):

```typescript
  isReply: { type: Boolean },
  replyParentPostId: { type: String },
  replyMode: { type: String, enum: ['together', 'separated'] },
```

- [ ] **Step 2: Add new SessionState values**

In `src/shared/constants/flow-states.ts`, extend the enum:

```typescript
export enum SessionState {
  CHANNEL_SELECT = 'channel_select',
  ACTION_SELECT = 'action_select',
  TEXT_HANDLING = 'text_handling',
  NICKNAME_SELECT = 'nickname_select',
  CUSTOM_TEXT = 'custom_text',
  PREVIEW = 'preview',
  COMPLETED = 'completed',
  WAITING_FOR_REPLY_CONTENT = 'waiting_for_reply_content',
  REPLY_SLOT_CHOICE = 'reply_slot_choice',
}
```

- [ ] **Step 3: Build check**

```bash
npm run build 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/database/models/session.model.ts src/shared/constants/flow-states.ts
git commit -m "feat: add reply session fields and new SessionState values"
```

---

### Task 3: Session state machine — transitions for new states

**Files:**
- Create: `src/core/session/__tests__/session-state-machine.test.ts`
- Modify: `src/core/session/session-state-machine.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/session/__tests__/session-state-machine.test.ts`:

```typescript
import { getNextState, getPossibleNextStates } from '../session-state-machine.js';
import { SessionState } from '../../../shared/constants/flow-states.js';

const base = { isGreenListed: false, isRedListed: false, hasText: false, isForward: false };

describe('session-state-machine — reply states', () => {
  describe('WAITING_FOR_REPLY_CONTENT', () => {
    it('transitions to CHANNEL_SELECT', () => {
      expect(getNextState(SessionState.WAITING_FOR_REPLY_CONTENT, base)).toBe(SessionState.CHANNEL_SELECT);
    });
    it('lists CHANNEL_SELECT as possible next state', () => {
      expect(getPossibleNextStates(SessionState.WAITING_FOR_REPLY_CONTENT)).toContain(SessionState.CHANNEL_SELECT);
    });
  });

  describe('REPLY_SLOT_CHOICE', () => {
    it('transitions to ACTION_SELECT', () => {
      expect(getNextState(SessionState.REPLY_SLOT_CHOICE, base)).toBe(SessionState.ACTION_SELECT);
    });
    it('lists ACTION_SELECT as possible next state', () => {
      expect(getPossibleNextStates(SessionState.REPLY_SLOT_CHOICE)).toContain(SessionState.ACTION_SELECT);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --testPathPattern="session-state-machine" 2>&1 | tail -20
```

Expected: FAIL — `getNextState` throws `Unknown state`.

- [ ] **Step 3: Add transitions in `session-state-machine.ts`**

In `getNextState`, add two new cases before `default`:

```typescript
    case SessionState.WAITING_FOR_REPLY_CONTENT:
      return SessionState.CHANNEL_SELECT;

    case SessionState.REPLY_SLOT_CHOICE:
      return SessionState.ACTION_SELECT;
```

In `getPossibleNextStates`, add two new cases before `default`:

```typescript
    case SessionState.WAITING_FOR_REPLY_CONTENT:
      return [SessionState.CHANNEL_SELECT];
    case SessionState.REPLY_SLOT_CHOICE:
      return [SessionState.ACTION_SELECT];
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --testPathPattern="session-state-machine" 2>&1 | tail -10
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/session/__tests__/session-state-machine.test.ts src/core/session/session-state-machine.ts
git commit -m "feat: add WAITING_FOR_REPLY_CONTENT and REPLY_SLOT_CHOICE state transitions"
```

---

### Task 4: SessionRepository and SessionService — reply session methods

**Files:**
- Modify: `src/database/repositories/session.repository.ts`
- Modify: `src/core/session/session.service.ts`

- [ ] **Step 1: Add `findWaitingForReplyContent` to `SessionRepository`**

In `src/database/repositories/session.repository.ts`, add after `findWaitingForCustomText`:

```typescript
  async findWaitingForReplyContent(userId: number): Promise<ISession | null> {
    return await this.model.findOne({
      userId,
      state: SessionState.WAITING_FOR_REPLY_CONTENT,
      expiresAt: { $gt: new Date() },
    });
  }
```

- [ ] **Step 2: Add `createForReply` and `findWaitingForReplyContent` to `SessionService`**

In `src/core/session/session.service.ts`, add after `createForEdit`:

```typescript
  /**
   * Create a session waiting for the user to send reply content.
   * messageId: -1 is a sentinel — will be updated to the real message_id when content arrives.
   */
  async createForReply(userId: number, parentPostId: string): Promise<ISession> {
    const expiresAt = new Date(Date.now() + SessionService.SESSION_TTL_MS);
    // Remove any existing reply sentinel session to avoid unique-index conflict
    await this.repository.deleteMany({ userId, messageId: -1 });

    const session = await this.repository.create({
      userId,
      messageId: -1,
      chatId: userId,
      state: SessionState.WAITING_FOR_REPLY_CONTENT,
      isReply: true,
      replyParentPostId: parentPostId,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt,
    } as Partial<ISession>);

    logger.debug(`Created reply session ${session._id} for user ${userId}, parent ${parentPostId}`);
    return session;
  }

  async findWaitingForReplyContent(userId: number): Promise<ISession | null> {
    return await this.repository.findWaitingForReplyContent(userId);
  }
```

- [ ] **Step 3: Build check**

```bash
npm run build 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/database/repositories/session.repository.ts src/core/session/session.service.ts
git commit -m "feat: add reply session creation and lookup methods"
```

---

### Task 5: ScheduledPostRepository — reply methods

**Files:**
- Modify: `src/database/repositories/scheduled-post.repository.ts`

- [ ] **Step 1: Add import and four new methods**

At the top of `src/database/repositories/scheduled-post.repository.ts`, add to the import line:

```typescript
import type { EmbeddedReplyData, IScheduledPost } from '../models/scheduled-post.model.js';
```

(The existing import imports `IScheduledPost` already — extend it to also import `EmbeddedReplyData`.)

The full updated import line:

```typescript
import { ScheduledPost, type IScheduledPost, type EmbeddedReplyData } from '../models/scheduled-post.model.js';
import type { RetryMetadata } from '../models/scheduled-post.model.js';
import type { MessageContent, TextHandling, TransformAction } from '../../types/message.types.js';
```

- [ ] **Step 2: Add `findOne`**

Add at the end of the class (before closing `}`):

```typescript
  async findOne(postId: string): Promise<IScheduledPost | null> {
    return await this.model.findById(postId);
  }
```

- [ ] **Step 3: Add `attachEmbeddedReply`**

```typescript
  /**
   * Set embeddedReply on a pending parent post.
   * Only updates posts with status 'pending' — returns null if already published.
   */
  async attachEmbeddedReply(
    parentPostId: string,
    replyData: EmbeddedReplyData
  ): Promise<IScheduledPost | null> {
    return await this.model.findOneAndUpdate(
      { _id: parentPostId, status: 'pending' },
      { $set: { embeddedReply: replyData } },
      { new: true }
    );
  }
```

- [ ] **Step 4: Add `convertToSeparatedReply`**

```typescript
  /**
   * Convert a freshly-created pending post into a separated reply.
   * If the parent is already posted, fills replyToMessageId/replyToChannelId and keeps status 'pending'.
   * If the parent is still pending, sets status to 'waiting_parent'.
   */
  async convertToSeparatedReply(
    postId: string,
    parentPostId: string,
    parentPost: IScheduledPost | null
  ): Promise<void> {
    const update: Record<string, unknown> = { parentPostId };

    if (parentPost?.status === 'posted' && parentPost.telegramScheduledMessageId) {
      update.replyToMessageId = parentPost.telegramScheduledMessageId;
      update.replyToChannelId = parentPost.targetChannelId;
    } else {
      update.status = 'waiting_parent';
    }

    await this.model.findByIdAndUpdate(postId, { $set: update });
  }
```

- [ ] **Step 5: Add `unblockSeparatedReplies`**

```typescript
  /**
   * After the parent post publishes, fill in the reply link and flip status to 'pending'.
   */
  async unblockSeparatedReplies(
    parentPostId: string,
    parentMessageId: number,
    parentChannelId: string
  ): Promise<void> {
    await this.model.updateMany(
      { parentPostId, status: 'waiting_parent' },
      {
        $set: {
          replyToMessageId: parentMessageId,
          replyToChannelId: parentChannelId,
          status: 'pending',
        },
      }
    );
  }
```

- [ ] **Step 6: Build check**

```bash
npm run build 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/database/repositories/scheduled-post.repository.ts
git commit -m "feat: add reply methods to ScheduledPostRepository"
```

---

### Task 6: New keyboard — reply-slot

**Files:**
- Create: `src/bot/keyboards/reply-slot.keyboard.ts`
- Modify: `src/bot/keyboards/preview-action.keyboard.ts`

- [ ] **Step 1: Create `reply-slot.keyboard.ts`**

```typescript
import type { InlineKeyboardMarkup } from 'grammy/types';

export function createReplySlotKeyboard(sessionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '📎 Same slot as parent', callback_data: `reply_slot:together:${sessionId}` },
        { text: '⏭ Next available slot', callback_data: `reply_slot:separated:${sessionId}` },
      ],
    ],
  };
}
```

- [ ] **Step 2: Add `createAddReplyKeyboard` to `preview-action.keyboard.ts`**

Append to `src/bot/keyboards/preview-action.keyboard.ts`:

```typescript
export function createAddReplyKeyboard(postId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '💬 Add a reply', callback_data: `reply_trigger:${postId}` },
      ],
    ],
  };
}
```

- [ ] **Step 3: Build check**

```bash
npm run build 2>&1 | head -40
```

- [ ] **Step 4: Commit**

```bash
git add src/bot/keyboards/reply-slot.keyboard.ts src/bot/keyboards/preview-action.keyboard.ts
git commit -m "feat: add reply-slot keyboard and add-reply keyboard"
```

---

### Task 7: PostPublisherService — embedded reply and separated reply support

**Files:**
- Modify: `src/core/posting/post-publisher.service.ts`
- Create: `src/core/posting/__tests__/post-publisher-reply.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/core/posting/__tests__/post-publisher-reply.test.ts`:

```typescript
import { PostPublisherService } from '../post-publisher.service.js';
import type { EmbeddedReplyData } from '../../../database/models/scheduled-post.model.js';

describe('PostPublisherService.publishEmbeddedReply', () => {
  it('sends transform reply with reply_parameters to target channel', async () => {
    const mockSendMessage = jest.fn().mockResolvedValue({ message_id: 42 });
    const mockApi = {
      sendMessage: mockSendMessage,
      sendPhoto: jest.fn(),
      sendVideo: jest.fn(),
      sendDocument: jest.fn(),
      sendAnimation: jest.fn(),
      sendMediaGroup: jest.fn(),
    } as any;

    const publisher = new PostPublisherService(mockApi);
    const replyData: EmbeddedReplyData = {
      targetChannelId: '-1001111',
      content: { type: 'text', text: 'hello reply' },
      action: 'transform',
      originalForward: { messageId: 1, chatId: 100 },
    };

    const msgId = await publisher.publishEmbeddedReply(replyData, 99, '-1002222');

    expect(msgId).toBe(42);
    expect(mockSendMessage).toHaveBeenCalledWith(
      '-1001111',
      'hello reply',
      expect.objectContaining({
        reply_parameters: { message_id: 99, chat_id: -1002222 },
      })
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --testPathPattern="post-publisher-reply" 2>&1 | tail -20
```

Expected: FAIL — `publishEmbeddedReply is not a function`.

- [ ] **Step 3: Add `publishEmbeddedReply` to `PostPublisherService`**

In `src/core/posting/post-publisher.service.ts`, add the import at the top:

```typescript
import type { EmbeddedReplyData } from '../../database/models/scheduled-post.model.js';
```

Add the new method after `copyMessage`:

```typescript
  /**
   * Publish an embedded (together) reply, using the parent's message_id as reply target.
   * For 'forward' action: uses copyMessage so reply_parameters can be attached
   * (forwardMessage does not support reply_parameters).
   */
  async publishEmbeddedReply(
    reply: EmbeddedReplyData,
    parentMessageId: number,
    parentChannelId: string
  ): Promise<number> {
    const replyParams = {
      messageId: parentMessageId,
      chatId: parseInt(parentChannelId, 10),
    };

    if (reply.action === 'forward') {
      const result = await this.api.copyMessage(
        reply.targetChannelId,
        reply.originalForward.chatId,
        reply.originalForward.messageId,
        { reply_parameters: { message_id: parentMessageId, chat_id: parseInt(parentChannelId, 10) } }
      );
      return result.message_id;
    }

    return await this.mediaSender.sendMessage(reply.targetChannelId, reply.content, replyParams);
  }
```

- [ ] **Step 4: Support `reply_parameters` in separated reply publishing**

In `PostPublisherService.copyMessage`, after the `bulkMessageIds` block, update the single-message forward to support reply parameters:

The existing `copyMessage` method ends with:

```typescript
    // Single message forward
    const result = await this.api.forwardMessage(
      post.targetChannelId,
      post.originalForward.chatId,
      post.originalForward.messageId
    );

    return result.message_id;
```

Replace the entire `copyMessage` method body with:

```typescript
  private async copyMessage(post: IScheduledPost): Promise<number> {
    if (!post.originalForward.chatId || !post.originalForward.messageId) {
      throw new Error('Missing chatId or messageId for forwardMessage');
    }

    const replyChain = post.originalForward.replyChainMessageIds;
    const mediaGroup = post.originalForward.mediaGroupMessageIds;
    const bulkMessageIds =
      replyChain && replyChain.length > 1
        ? replyChain
        : mediaGroup && mediaGroup.length > 1
          ? mediaGroup
          : null;

    if (bulkMessageIds) {
      const result = await this.api.forwardMessages(
        post.targetChannelId,
        post.originalForward.chatId,
        bulkMessageIds
      );
      return result[0].message_id;
    }

    // If this is a separated reply, use copyMessage so reply_parameters can be passed.
    // forwardMessage does not support reply_parameters.
    if (post.replyToMessageId && post.replyToChannelId) {
      const result = await this.api.copyMessage(
        post.targetChannelId,
        post.originalForward.chatId,
        post.originalForward.messageId,
        {
          reply_parameters: {
            message_id: post.replyToMessageId,
            chat_id: parseInt(post.replyToChannelId, 10),
          },
        }
      );
      return result.message_id;
    }

    const result = await this.api.forwardMessage(
      post.targetChannelId,
      post.originalForward.chatId,
      post.originalForward.messageId
    );

    return result.message_id;
  }
```

Also update `publish` to pass `reply_parameters` through for transform-action separated replies. In `publish`:

```typescript
  async publish(post: IScheduledPost): Promise<number> {
    if (post.action === 'forward') {
      return await this.copyMessage(post);
    }

    const replyParams = post.replyToMessageId && post.replyToChannelId
      ? { messageId: post.replyToMessageId, chatId: parseInt(post.replyToChannelId, 10) }
      : post.originalForward.replyParameters;

    return await this.mediaSender.sendMessage(
      post.targetChannelId,
      post.content,
      replyParams
    );
  }
```

- [ ] **Step 5: Run tests**

```bash
npm test -- --testPathPattern="post-publisher-reply" 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 6: Build check**

```bash
npm run build 2>&1 | head -40
```

- [ ] **Step 7: Commit**

```bash
git add src/core/posting/post-publisher.service.ts src/core/posting/__tests__/post-publisher-reply.test.ts
git commit -m "feat: add publishEmbeddedReply and reply_parameters support to PostPublisherService"
```

---

### Task 8: PostWorkerService — publish embedded reply and unblock separated

**Files:**
- Modify: `src/services/post-worker.service.ts`

- [ ] **Step 1: Import `ScheduledPost` model**

At the top of `src/services/post-worker.service.ts`, update the import:

```typescript
import { ScheduledPost, type IScheduledPost } from '../database/models/scheduled-post.model.js';
```

(It already imports both — verify `ScheduledPost` (the mongoose model) is included, not just the type.)

- [ ] **Step 2: Update `publishPost` to handle replies**

Replace the entire `publishPost` method:

```typescript
  private async publishPost(post: IScheduledPost) {
    try {
      logger.info(
        `Publishing ${post.content.type} post to ${post.targetChannelId} (scheduled for ${formatSlotTime(post.scheduledTime)})`
      );

      const messageId = await this.publisher.publish(post);

      await post.updateOne({ status: 'posted', postedAt: new Date(), telegramScheduledMessageId: messageId });

      // Publish together (embedded) reply atomically in the same cycle
      if (post.embeddedReply) {
        try {
          await this.publisher.publishEmbeddedReply(post.embeddedReply, messageId, post.targetChannelId);
          logger.info(`Published embedded reply for post ${post._id}`);
        } catch (error) {
          logger.error(`Failed to publish embedded reply for post ${post._id}:`, error);
          await post.updateOne({
            embeddedReplyError: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Unblock separated reply posts that were waiting for this parent
      await ScheduledPost.updateMany(
        { parentPostId: post._id.toString(), status: 'waiting_parent' },
        {
          $set: {
            replyToMessageId: messageId,
            replyToChannelId: post.targetChannelId,
            status: 'pending',
          },
        }
      );

      logger.info(`Successfully published post ${post._id} with message_id ${messageId}`);
    } catch (error) {
      logger.error(`Failed to publish post ${post._id}:`, error);
      await post.updateOne({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
```

- [ ] **Step 3: Build check**

```bash
npm run build 2>&1 | head -40
```

- [ ] **Step 4: Commit**

```bash
git add src/services/post-worker.service.ts
git commit -m "feat: publish embedded reply and unblock separated replies in post worker"
```

---

### Task 9: Forward handler — intercept WAITING_FOR_REPLY_CONTENT

**Files:**
- Modify: `src/bot/handlers/forward.handler.ts`

- [ ] **Step 1: Add imports**

Add to the existing imports in `src/bot/handlers/forward.handler.ts`:

```typescript
import { createChannelSelectKeyboard } from '../keyboards/channel-select.keyboard.js';
import type { ISession } from '../../database/models/session.model.js';
```

(Check if `createChannelSelectKeyboard` is already imported — if so, skip that line.)

- [ ] **Step 2: Add `handleReplyContent` helper function**

Add this function after the `getSessionService` definition:

```typescript
async function handleReplyContent(
  ctx: Context,
  message: Message,
  replySession: ISession,
  sessionSvc: SessionService
): Promise<void> {
  const sessionId = replySession._id.toString();

  // Update session: set the real message, advance to CHANNEL_SELECT
  await sessionSvc.updateState(sessionId, SessionState.CHANNEL_SELECT, {
    originalMessage: message,
    messageId: message.message_id,
    chatId: message.chat.id,
  });

  const postingChannels = await getActivePostingChannels();
  if (postingChannels.length === 0) {
    await ctx.reply('⚠️ No posting channels configured. Add channels first with /addchannel.');
    return;
  }

  const channels = postingChannels.map((ch) => ({
    id: ch.channelId,
    title: ch.channelTitle ?? ch.channelId,
    username: ch.channelUsername,
  }));

  const keyboard = createChannelSelectKeyboard(channels);
  await ctx.reply('Choose the target channel for this reply:', { reply_markup: keyboard });
}
```

- [ ] **Step 3: Intercept in `processSingleMessage`**

At the very beginning of `processSingleMessage` (before the idempotency check), add:

```typescript
  // Check for a reply session waiting for content before starting a new standalone session
  try {
    const userId = ctx.from?.id;
    if (userId) {
      const sessionSvc = getSessionService();
      const replySession = await sessionSvc.findWaitingForReplyContent(userId);
      if (replySession) {
        await handleReplyContent(ctx, message, replySession, sessionSvc);
        return;
      }
    }
  } catch (error) {
    logger.error('Error checking for reply session:', error);
    // Fall through to normal processing
  }
```

- [ ] **Step 4: Build check**

```bash
npm run build 2>&1 | head -40
```

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers/forward.handler.ts
git commit -m "feat: intercept incoming messages for WAITING_FOR_REPLY_CONTENT sessions"
```

---

### Task 10: New callback file — reply trigger handlers

**Files:**
- Create: `src/bot/handlers/callbacks/reply.ts`

This file handles `reply_trigger:<parentPostId>` (from post confirmation) and `queue_reply:<postId>` (from queue preview). Both create a reply session and prompt for content.

- [ ] **Step 1: Create `reply.ts`**

```typescript
// src/bot/handlers/callbacks/reply.ts
import { Context } from 'grammy';
import { bot } from '../../bot.js';
import { logger } from '../../../utils/logger.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { getSessionService } from './shared.js';

export function registerReply(): void {

  // Triggered from post confirmation message after scheduling
  bot.callbackQuery(/^reply_trigger:(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const parentPostId = ctx.callbackQuery?.data?.match(/^reply_trigger:(.+)$/)?.[1];
      if (!parentPostId) {
        await ctx.answerCallbackQuery({ text: 'Invalid post reference.' });
        return;
      }

      const fromId = ctx.from?.id;
      if (!fromId) return;

      const sessionSvc = getSessionService();
      await sessionSvc.createForReply(fromId, parentPostId);

      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.reply('💬 Send the content for this reply. You can forward a message or send any media/text.');

      logger.debug(`Reply session created for user ${fromId}, parent post ${parentPostId}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Failed to start reply flow. Please try again.',
        'Error in reply_trigger callback'
      );
    }
  });

  // Triggered from queue preview action keyboard
  bot.callbackQuery(/^queue_reply:(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const postId = ctx.callbackQuery?.data?.match(/^queue_reply:(.+)$/)?.[1];
      if (!postId) {
        await ctx.answerCallbackQuery({ text: 'Invalid post reference.' });
        return;
      }

      const fromId = ctx.from?.id;
      if (!fromId) return;

      const sessionSvc = getSessionService();
      await sessionSvc.createForReply(fromId, postId);

      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.reply('💬 Send the content for this reply. You can forward a message or send any media/text.');

      logger.debug(`Reply session created from queue for user ${fromId}, post ${postId}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Failed to start reply flow. Please try again.',
        'Error in queue_reply callback'
      );
    }
  });

}
```

- [ ] **Step 2: Register in `index.ts`**

In `src/bot/handlers/callbacks/index.ts`:

```typescript
import { registerScheduling } from './scheduling.js';
import { registerQueue } from './queue.js';
import { registerSleep } from './sleep.js';
import { registerInterval } from './interval.js';
import { registerReply } from './reply.js';

registerScheduling();
registerQueue();
registerSleep();
registerInterval();
registerReply();
```

- [ ] **Step 3: Build check**

```bash
npm run build 2>&1 | head -40
```

- [ ] **Step 4: Commit**

```bash
git add src/bot/handlers/callbacks/reply.ts src/bot/handlers/callbacks/index.ts
git commit -m "feat: add reply_trigger and queue_reply callback handlers"
```

---

### Task 11: Queue preview keyboard — add reply button

**Files:**
- Modify: `src/bot/keyboards/queue-preview-action.keyboard.ts`

- [ ] **Step 1: Add "💬 Add reply" button**

Replace the file content with:

```typescript
import { InlineKeyboard } from 'grammy';

export function createQueuePreviewActionKeyboard(postId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✏️ Edit', `queue:edit:${postId}`)
    .text('🗑 Delete post', `queue:del:${postId}`)
    .row()
    .text('💬 Add reply', `queue_reply:${postId}`)
    .row()
    .text('⬅ Back to queue', 'queue:back');
}
```

- [ ] **Step 2: Build check**

```bash
npm run build 2>&1 | head -40
```

- [ ] **Step 3: Commit**

```bash
git add src/bot/keyboards/queue-preview-action.keyboard.ts
git commit -m "feat: add reply button to queue preview action keyboard"
```

---

### Task 12: scheduling.ts — channel selection for reply sessions + reply_slot callbacks

**Files:**
- Modify: `src/bot/handlers/callbacks/scheduling.ts`

This task has two additions to `scheduling.ts`:

**Addition A:** After finding the session in `select_channel`, detect `session.isReply` and show the reply-slot keyboard instead of the action keyboard.

**Addition B:** Register `reply_slot:together:<sessionId>` and `reply_slot:separated:<sessionId>` callbacks.

- [ ] **Step 1: Add imports to `scheduling.ts`**

Add these imports at the top of `src/bot/handlers/callbacks/scheduling.ts`:

```typescript
import { createReplySlotKeyboard } from '../../keyboards/reply-slot.keyboard.js';
import { transformerService as transformerSvcForReply } from '../../../services/transformer.service.js';
```

(The second import aliases to avoid collision — check if `transformerService` is already imported under a different name. It is imported as `transformerService` — use that directly, skip the alias.)

Actually just add:
```typescript
import { createReplySlotKeyboard } from '../../keyboards/reply-slot.keyboard.js';
```

- [ ] **Step 2: Modify `select_channel` to handle reply sessions**

In the `select_channel` callback, find the state-update block (around line 83):

```typescript
      const sessionSvc = getSessionService();
      if (session && sessionSvc) {
        const nextState = getNextState(SessionState.CHANNEL_SELECT, {
          isGreenListed: shouldAutoForward,
          isRedListed: false,
          hasText: false,
          isForward: false,
        });
        await sessionSvc.updateState(session._id.toString(), nextState, {
          selectedChannel: selectedChannelId,
        });
      }
```

Replace it with (the reply check goes INSIDE the block, before computing `nextState`):

```typescript
      const sessionSvc = getSessionService();
      if (session && sessionSvc) {
        // Reply sessions: advance to REPLY_SLOT_CHOICE and show slot keyboard
        if (session.isReply) {
          await sessionSvc.updateState(session._id.toString(), SessionState.REPLY_SLOT_CHOICE, {
            selectedChannel: selectedChannelId,
          });
          const slotKeyboard = createReplySlotKeyboard(session._id.toString());
          await ctx.editMessageText('When should this reply be sent?', { reply_markup: slotKeyboard });
          return;
        }

        const nextState = getNextState(SessionState.CHANNEL_SELECT, {
          isGreenListed: shouldAutoForward,
          isRedListed: false,
          hasText: false,
          isForward: false,
        });
        await sessionSvc.updateState(session._id.toString(), nextState, {
          selectedChannel: selectedChannelId,
        });
      }
```

- [ ] **Step 3: Add `reply_slot` callbacks inside `registerScheduling`**

Add at the end of the `registerScheduling` function body, before the closing `}`:

```typescript
  // Handle reply slot choice: together (same cycle as parent) or separated (own slot)
  bot.callbackQuery(/^reply_slot:(together|separated):(.+)$/, async (ctx: Context) => {
    try {
      await ctx.answerCallbackQuery().catch(() => {});

      const match = ctx.callbackQuery?.data?.match(/^reply_slot:(together|separated):(.+)$/);
      const mode = match?.[1] as 'together' | 'separated';
      const sessionId = match?.[2];

      if (!mode || !sessionId) {
        await ctx.editMessageText('❌ Invalid reply slot selection.');
        return;
      }

      const sessionSvc = getSessionService();
      const session = await sessionSvc.findById(sessionId);
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      await sessionSvc.update(sessionId, { replyMode: mode });

      // Check for green-listed source — auto-forward if applicable
      const originalMessage = session.originalMessage;
      if (originalMessage) {
        const forwardInfo = parseForwardInfo(originalMessage);
        const shouldAutoForward = await transformerService.shouldAutoForward(forwardInfo);

        if (shouldAutoForward) {
          await sessionSvc.update(sessionId, { selectedAction: 'forward' });
          await showPreview(ctx, sessionId);
          return;
        }

        const content = extractMessageContent(originalMessage);
        if (content?.type === 'poll') {
          await sessionSvc.update(sessionId, { selectedAction: 'forward' });
          await showPreview(ctx, sessionId);
          return;
        }
      }

      const keyboard = createForwardActionKeyboard();
      await ctx.editMessageText(
        'Choose how to post this reply:\n⚡ <b>Quick post</b> — transform, no attribution, no extra text',
        { reply_markup: keyboard, parse_mode: 'HTML' }
      );

      logger.debug(`Reply slot mode "${mode}" set for session ${sessionId}`);
    } catch (error) {
      await ErrorMessages.catchAndReply(
        ctx,
        error,
        'Error processing reply slot selection. Please try again.',
        'Error in reply_slot callback'
      );
    }
  });
```

- [ ] **Step 4: Build check**

```bash
npm run build 2>&1 | head -40
```

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers/callbacks/scheduling.ts
git commit -m "feat: channel select detects reply sessions; add reply_slot callbacks"
```

---

### Task 13: scheduling.ts — preview:schedule reply path + confirmation button

**Files:**
- Modify: `src/bot/handlers/callbacks/scheduling.ts`

- [ ] **Step 1: Add imports**

Add to the imports at the top of `scheduling.ts`:

```typescript
import { createAddReplyKeyboard } from '../../keyboards/preview-action.keyboard.js';
import type { EmbeddedReplyData } from '../../../database/models/scheduled-post.model.js';
import { ScheduledPostRepository } from '../../../database/repositories/scheduled-post.repository.js';
```

(`ScheduledPostRepository` is already imported — skip if present. `EmbeddedReplyData` is new.)

- [ ] **Step 2: Handle reply sessions in `preview:schedule`**

In the `preview:schedule` callback, right after the edit-session block (around line 592, after the `if (session.editingPostId) { ... }` block ends), add the reply-session block BEFORE the existing normal-session scheduling code:

```typescript
      // ── Reply-session confirm ──────────────────────────────────────────────
      if (session.isReply && session.replyParentPostId) {
        const replyOriginalMessage = session.originalMessage;
        if (!replyOriginalMessage) {
          await ctx.reply('Reply session is corrupted. Please start over.');
          return;
        }

        const replySelectedChannel = session.selectedChannel;
        if (!replySelectedChannel) {
          await ctx.reply('No channel selected for reply.');
          return;
        }

        const repository = new ScheduledPostRepository();
        const parentPost = await repository.findOne(session.replyParentPostId);

        const replyForwardInfo = parseForwardInfo(replyOriginalMessage);
        const replyMediaGroupMessages = session.mediaGroupMessages;
        if (replyMediaGroupMessages && replyMediaGroupMessages.length > 1) {
          replyForwardInfo.mediaGroupMessageIds = replyMediaGroupMessages.map((m) => m.message_id);
        }

        const replyContent = extractMessageContent(replyOriginalMessage, replyMediaGroupMessages);
        if (!replyContent) {
          await ctx.reply('Unsupported reply content type.');
          return;
        }

        const {
          textHandling: replyTextHandling = 'keep',
          selectedUserId: replyUserId,
          customText: replyCustomText,
          selectedAction: replyAction = 'transform',
        } = session;

        if (session.replyMode === 'together') {
          const replyNickname = replyUserId ? await findNicknameByUserId(replyUserId) : null;
          const replyText =
            replyAction === 'transform'
              ? await transformerService.transformMessage(
                  replyContent.text ?? '',
                  replyForwardInfo,
                  'transform',
                  replyTextHandling,
                  replyNickname,
                  replyCustomText
                )
              : replyContent.text ?? '';

          const transformedReplyContent = { ...replyContent, text: replyText };

          const replyData: EmbeddedReplyData = {
            targetChannelId: replySelectedChannel,
            content: transformedReplyContent,
            rawContent: replyContent,
            action: replyAction,
            textHandling: replyTextHandling,
            selectedUserId: replyUserId ?? null,
            customText: replyCustomText,
            originalForward: replyForwardInfo,
          };

          const attached = await repository.attachEmbeddedReply(session.replyParentPostId, replyData);

          if (fromId) await deletePreviewMessages(ctx, fromId, session);
          await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
          await sessionSvc.complete(sessionKey);

          if (!attached) {
            await ctx.reply('⚠️ Parent post was already published — reply could not be attached.');
            return;
          }

          const parentSlotTime = parentPost?.scheduledTime;
          await ctx.reply(
            `↩️ Reply scheduled with the parent post${parentSlotTime ? ` at ${formatSlotTime(parentSlotTime)}` : ''}`
          );
          logger.info(`Together reply attached to parent post ${session.replyParentPostId}`);
          return;
        }

        // Separated reply: schedule normally, then convert to separated reply
        const baseReplyParams = {
          targetChannelId: replySelectedChannel,
          originalMessage: replyOriginalMessage,
          forwardInfo: replyForwardInfo,
          content: replyContent,
        };

        const { scheduledTime: replySlotTime, postId: replyPostId } =
          replyAction === 'forward'
            ? await postScheduler.scheduleForwardPost(baseReplyParams)
            : await postScheduler.scheduleTransformPost({
                ...baseReplyParams,
                textHandling: replyTextHandling,
                selectedUserId: replyUserId,
                customText: replyCustomText,
              });

        await repository.convertToSeparatedReply(replyPostId, session.replyParentPostId, parentPost ?? null);

        if (fromId) await deletePreviewMessages(ctx, fromId, session);
        await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
        await sessionSvc.complete(sessionKey);

        await ctx.reply(`↩️ Reply scheduled for ${formatSlotTime(replySlotTime)}`);
        logger.info(`Separated reply scheduled at ${formatSlotTime(replySlotTime)}, post ${replyPostId}`);
        return;
      }
      // ── End reply-session confirm ──────────────────────────────────────────
```

- [ ] **Step 3: Add "Add a reply" button to the normal scheduling confirmation**

Find the normal scheduling confirmation (at the end of the `preview:schedule` callback body). Currently:

```typescript
      await ctx.reply(
        `Post scheduled!\nTarget: ${channelLabel}\nScheduled for: ${formatSlotTime(scheduledTime)}`
      );
```

Change the destructuring line from:
```typescript
      const { scheduledTime } = session.selectedAction === 'forward'
```
to:
```typescript
      const { scheduledTime, postId } = session.selectedAction === 'forward'
```

Then replace the `ctx.reply` call with:

```typescript
      await ctx.reply(
        `Post scheduled!\nTarget: ${channelLabel}\nScheduled for: ${formatSlotTime(scheduledTime)}`,
        { reply_markup: createAddReplyKeyboard(postId) }
      );
```

- [ ] **Step 4: Build check**

```bash
npm run build 2>&1 | head -40
```

- [ ] **Step 5: Run all tests**

```bash
npm test 2>&1 | tail -20
```

Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/bot/handlers/callbacks/scheduling.ts
git commit -m "feat: handle reply sessions in preview:schedule and show reply button on confirmation"
```

---

### Task 14: Final build verification and push

- [ ] **Step 1: Full build**

```bash
npm run build 2>&1
```

Expected: zero errors, zero warnings about the reply feature.

- [ ] **Step 2: Run all tests**

```bash
npm test 2>&1
```

Expected: all tests pass including the 4 state-machine tests and 1 publisher test.

- [ ] **Step 3: Push to remote**

```bash
git push
```

---

## Manual Smoke Test Checklist

After deploying or running locally (`npm run dev`):

1. **Inline trigger (together):**
   - Forward a message → schedule it → confirmation shows "💬 Add a reply"
   - Click → bot says "Send the content for this reply"
   - Send a photo → channel select appears → pick channel → "Same slot as parent"
   - Transform → keep text → nickname → custom text → preview → schedule
   - Confirm: "↩️ Reply scheduled with the parent post at [time]"
   - Wait for post to publish — verify reply appears in channel thread

2. **Inline trigger (separated):**
   - Same flow but click "⏭ Next available slot"
   - Confirm: "↩️ Reply scheduled for [time]"
   - Parent publishes → verify separated reply post flips to `pending` in DB
   - Reply publishes at its own slot with `reply_parameters` set

3. **Via /queue:**
   - `/queue` → select channel → view a post preview
   - "💬 Add reply" button appears → same flow as above

4. **Edge case — parent already posted (via /queue):**
   - Add reply to a post with `status: 'posted'`
   - Verify: reply is created as `status: 'pending'` with `replyToMessageId` pre-filled
