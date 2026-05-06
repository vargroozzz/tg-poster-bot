# Queue Post Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "✏️ Edit" button to queue post previews that lets the user run the full scheduling re-flow (channel → action → text → nickname → custom text → preview) and then updates the post in-place (same channel) or delete+reschedules it (new channel).

**Architecture:** A parallel edit flow uses `queue:edit:*` callback data with `sessionId` embedded at every step — no `reply_to_message` dependency, no message forwarding. An "edit session" is created from the scheduled post's stored data. `ScheduledPost` gains `rawContent`/`textHandling`/`selectedNickname`/`customText` fields so the re-flow can re-apply transformation. Existing `preview:schedule/back/cancel` callbacks branch on `session.editingPostId`.

**Tech Stack:** TypeScript, Grammy, Mongoose, Vitest

---

## File Map

| Status | File | Change |
|---|---|---|
| Modify | `src/database/models/scheduled-post.model.ts` | +4 raw scheduling fields |
| Modify | `src/database/models/session.model.ts` | +5 edit fields, `originalMessage` optional |
| Modify | `src/core/posting/post-scheduler.service.ts` | save raw fields; `originalMessage?` optional |
| Modify | `src/database/repositories/scheduled-post.repository.ts` | add `updatePost()` |
| Modify | `src/core/session/session.service.ts` | add `createForEdit()` |
| Modify | `src/core/preview/preview-generator.service.ts` | edit-session branch |
| Modify | `src/core/preview/preview-sender.service.ts` | edit-session forward branch |
| Modify | `src/bot/keyboards/queue-preview-action.keyboard.ts` | add Edit button |
| Create | `src/bot/keyboards/edit-keyboards.ts` | all edit-flow keyboards |
| Modify | `src/bot/handlers/callback.handler.ts` | export map; edit branches in preview callbacks |
| Create | `src/bot/handlers/queue-edit.handler.ts` | all `queue:edit:*` callbacks |
| Modify | `src/index.ts` | import queue-edit handler |

---

### Task 1: Extend ScheduledPost model with raw scheduling fields

**Files:**
- Modify: `src/database/models/scheduled-post.model.ts`

- [ ] **Step 1: Add fields to interface and schema**

In `src/database/models/scheduled-post.model.ts`, add to the `IScheduledPost` interface (after the `action` field):

```typescript
  rawContent?: MessageContent;
  textHandling?: 'keep' | 'remove' | 'quote';
  selectedNickname?: string | null;
  customText?: string;
```

Add to `scheduledPostSchema` (after the `action` field definition):

```typescript
  rawContent: {
    type: Schema.Types.Mixed,
  },
  textHandling: {
    type: String,
    enum: ['keep', 'remove', 'quote'],
  },
  selectedNickname: {
    type: String,
    default: null,
  },
  customText: String,
```

- [ ] **Step 2: Build to verify no TypeScript errors**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/database/models/scheduled-post.model.ts
git commit -m "feat: add raw scheduling fields to ScheduledPost model"
```

---

### Task 2: Persist raw fields in PostSchedulerService

**Files:**
- Modify: `src/core/posting/post-scheduler.service.ts`

`originalMessage` is in both method signatures but never used — make it optional now so we can call these methods from edit flow without a fake Message.

- [ ] **Step 1: Make `originalMessage` optional and save raw fields**

Replace the `scheduleTransformPost` params type and `repository.create` call:

```typescript
  async scheduleTransformPost(params: {
    targetChannelId: string;
    originalMessage?: Message;
    forwardInfo: ForwardInfo;
    content: MessageContent;
    textHandling: TextHandling;
    selectedNickname?: string | null;
    customText?: string;
  }): Promise<{ scheduledTime: Date; postId: string }> {
    const {
      targetChannelId,
      forwardInfo,
      content,
      textHandling,
      selectedNickname,
      customText,
    } = params;

    const nextSlot = await findNextAvailableSlot(targetChannelId);

    const originalText = content.text ?? '';
    const transformedText = await transformerService.transformMessage(
      originalText,
      forwardInfo,
      'transform',
      textHandling,
      selectedNickname,
      customText
    );

    const transformedContent = {
      ...content,
      text: transformedText,
    };

    const scheduledPost = await this.repository.create({
      scheduledTime: nextSlot,
      targetChannelId,
      status: 'pending',
      action: 'transform',
      originalForward: forwardInfo,
      content: transformedContent,
      rawContent: content,
      textHandling,
      selectedNickname: selectedNickname ?? null,
      customText,
      createdAt: new Date(),
    });

    return {
      scheduledTime: nextSlot,
      postId: scheduledPost._id.toString(),
    };
  }
```

Replace `scheduleForwardPost` params type and `repository.create` call:

```typescript
  async scheduleForwardPost(params: {
    targetChannelId: string;
    originalMessage?: Message;
    forwardInfo: ForwardInfo;
    content: MessageContent;
  }): Promise<{ scheduledTime: Date; postId: string }> {
    const { targetChannelId, forwardInfo, content } = params;

    const nextSlot = await findNextAvailableSlot(targetChannelId);

    const processedText = await transformerService.transformMessage(
      content.text ?? '',
      forwardInfo,
      'forward',
      'keep',
      undefined,
      undefined
    );

    const processedContent = {
      ...content,
      text: processedText,
    };

    const scheduledPost = await this.repository.create({
      scheduledTime: nextSlot,
      targetChannelId,
      status: 'pending',
      action: 'forward',
      originalForward: forwardInfo,
      content: processedContent,
      rawContent: content,
      textHandling: 'keep',
      selectedNickname: null,
      createdAt: new Date(),
    });

    return {
      scheduledTime: nextSlot,
      postId: scheduledPost._id.toString(),
    };
  }
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/posting/post-scheduler.service.ts
git commit -m "feat: persist raw scheduling fields and make originalMessage optional"
```

---

### Task 3: Add updatePost to ScheduledPostRepository

**Files:**
- Modify: `src/database/repositories/scheduled-post.repository.ts`

- [ ] **Step 1: Add import and method**

At the top of the file, the import already includes `IScheduledPost`. Add `MessageContent`, `TextHandling`, `TransformAction` to the type imports if not already present. The model file re-exports these from `message.types.ts` — import from there:

```typescript
import type { MessageContent, TextHandling, TransformAction } from '../../types/message.types.js';
```

Add method at the end of the class (before the closing `}`):

```typescript
  /**
   * Update content and scheduling parameters of a pending post in-place.
   * scheduledTime is intentionally not touched.
   */
  async updatePost(
    postId: string,
    updates: {
      content: MessageContent;
      action: TransformAction;
      rawContent: MessageContent;
      textHandling?: TextHandling;
      selectedNickname?: string | null;
      customText?: string;
    }
  ): Promise<void> {
    await this.model.findByIdAndUpdate(postId, updates);
  }
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/database/repositories/scheduled-post.repository.ts
git commit -m "feat: add updatePost to ScheduledPostRepository"
```

---

### Task 4: Extend Session model with edit fields

**Files:**
- Modify: `src/database/models/session.model.ts`

Edit sessions have no real Telegram message, so `originalMessage` becomes optional. `messageId: 0` is used as the sentinel (Telegram IDs start at 1).

- [ ] **Step 1: Add imports and extend interface**

Add to the import at the top:

```typescript
import type { ForwardInfo, MessageContent } from '../../types/message.types.js';
```

Extend `ISession` interface (add after `previewMessageIds?`):

```typescript
  editingPostId?: string;
  editingOriginalChannelId?: string;
  editingOriginalScheduledTime?: Date;
  editingRawContent?: MessageContent;
  editingOriginalForward?: ForwardInfo;
```

Change `originalMessage` in the interface from required to optional:

```typescript
  originalMessage?: Message;
```

- [ ] **Step 2: Update schema**

Change `originalMessage` schema field to `required: false`:

```typescript
  originalMessage: {
    type: Schema.Types.Mixed,
    required: false,
  },
```

Add new schema fields (after `previewMessageIds`):

```typescript
  editingPostId: { type: String },
  editingOriginalChannelId: { type: String },
  editingOriginalScheduledTime: { type: Date },
  editingRawContent: { type: Schema.Types.Mixed },
  editingOriginalForward: { type: Schema.Types.Mixed },
```

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: zero errors. If TypeScript complains about `session.originalMessage` access without null-check in other files, add `!` assertions where the existing code already guarantees `originalMessage` is set (non-edit sessions). Search for callsites:

```bash
grep -rn "session\.originalMessage\b" src/ --include="*.ts"
```

Add `!` (non-null assertion) at each callsite that is in a non-edit code path. The new edit callbacks in queue-edit.handler.ts will never access `session.originalMessage`, so those are safe.

- [ ] **Step 4: Commit**

```bash
git add src/database/models/session.model.ts
git commit -m "feat: add edit session fields to Session model"
```

---

### Task 5: Add createForEdit to SessionService

**Files:**
- Modify: `src/core/session/session.service.ts`

- [ ] **Step 1: Add import**

Add to imports at top of file:

```typescript
import type { IScheduledPost } from '../../database/models/scheduled-post.model.js';
```

- [ ] **Step 2: Add method**

Add after the `create` method:

```typescript
  /**
   * Create a session for editing an existing scheduled post.
   * No originalMessage — edit callbacks use sessionId directly.
   * messageId: 0 is a sentinel (Telegram IDs start at 1).
   */
  async createForEdit(userId: number, post: IScheduledPost): Promise<ISession> {
    const expiresAt = new Date(Date.now() + SessionService.SESSION_TTL_MS);

    // Delete any existing edit session for this user to avoid unique-index conflict
    await this.repository.deleteWhere({ userId, messageId: 0 });

    const session = await this.repository.create({
      userId,
      messageId: 0,
      chatId: userId,
      state: SessionState.CHANNEL_SELECT,
      editingPostId: post._id.toString(),
      editingOriginalChannelId: post.targetChannelId,
      editingOriginalScheduledTime: post.scheduledTime,
      editingRawContent: post.rawContent ?? post.content,
      editingOriginalForward: post.originalForward,
      selectedChannel: post.targetChannelId,
      selectedAction: post.action,
      textHandling: post.textHandling,
      selectedNickname: post.selectedNickname,
      customText: post.customText,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt,
    } as Partial<ISession>);

    logger.debug(`Created edit session ${session._id} for user ${userId}, post ${post._id}`);
    return session;
  }
```

- [ ] **Step 3: Add deleteWhere to SessionRepository**

The `deleteWhere` helper doesn't exist yet. Add it to `src/database/repositories/session.repository.ts` (add at end of class):

```typescript
  async deleteWhere(filter: Partial<{ userId: number; messageId: number }>): Promise<void> {
    await this.model.deleteMany(filter);
  }
```

- [ ] **Step 4: Build**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/session/session.service.ts src/database/repositories/session.repository.ts
git commit -m "feat: add createForEdit to SessionService"
```

---

### Task 6: Update PreviewGeneratorService for edit sessions

**Files:**
- Modify: `src/core/preview/preview-generator.service.ts`
- Test: `src/core/preview/__tests__/preview-generator.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/core/preview/__tests__/preview-generator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PreviewGeneratorService } from '../preview-generator.service.js';
import type { ISession } from '../../../database/models/session.model.js';

describe('PreviewGeneratorService — edit session', () => {
  const service = new PreviewGeneratorService();

  it('returns rawContent unchanged for forward action', async () => {
    const session = {
      _id: 'sess1',
      editingPostId: 'post1',
      selectedAction: 'forward',
      editingRawContent: { type: 'text', text: 'Original text' },
      editingOriginalForward: { chatId: -1001, messageId: 99 },
      textHandling: 'keep',
    } as unknown as ISession;

    const result = await service.generatePreview(session);
    expect(result).toEqual({ type: 'text', text: 'Original text' });
  });

  it('throws when editingRawContent is missing', async () => {
    const session = {
      _id: 'sess2',
      editingPostId: 'post2',
      selectedAction: 'transform',
      // editingRawContent intentionally omitted
      editingOriginalForward: { chatId: -1001, messageId: 99 },
    } as unknown as ISession;

    await expect(service.generatePreview(session)).rejects.toThrow('no editingRawContent');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npm test -- src/core/preview/__tests__/preview-generator.test.ts
```

Expected: FAIL — test file can't find the edit path yet.

- [ ] **Step 3: Implement edit-session branch**

In `src/core/preview/preview-generator.service.ts`, add a private method and branch at the start of `generatePreview`:

```typescript
  async generatePreview(session: ISession): Promise<MessageContent> {
    logger.debug(`Generating preview for session ${session._id}, action: ${session.selectedAction}`);

    if (session.editingPostId) {
      return this.generatePreviewForEdit(session);
    }

    // ... rest of existing code unchanged
```

Add the private method at the end of the class:

```typescript
  private async generatePreviewForEdit(session: ISession): Promise<MessageContent> {
    const rawContent = session.editingRawContent;
    if (!rawContent) {
      throw new Error(`Edit session ${session._id} has no editingRawContent`);
    }

    if (session.selectedAction === 'forward') {
      return rawContent;
    }

    const forwardInfo = session.editingOriginalForward;
    if (!forwardInfo) {
      throw new Error(`Edit session ${session._id} has no editingOriginalForward`);
    }

    const transformedText = await transformerService.transformMessage(
      rawContent.text ?? '',
      forwardInfo,
      'transform',
      session.textHandling ?? 'keep',
      session.selectedNickname,
      session.customText
    );

    return { ...rawContent, text: transformedText };
  }
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- src/core/preview/__tests__/preview-generator.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Build**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/preview/__tests__/preview-generator.test.ts src/core/preview/preview-generator.service.ts
git commit -m "feat: add edit-session preview generation path"
```

---

### Task 7: Update PreviewSenderService for edit sessions (forward path)

**Files:**
- Modify: `src/core/preview/preview-sender.service.ts`

The forward-action preview uses `session.originalMessage.chat.id` and `session.originalMessage.message_id`. For edit sessions these are absent — use `session.editingOriginalForward` instead.

- [ ] **Step 1: Replace the forward-action block**

In `sendPreview`, replace the existing `if (session?.selectedAction === 'forward')` block with:

```typescript
    if (session?.selectedAction === 'forward') {
      let sourceChatId: number;
      let bulkMessageIds: number[] | null = null;
      let singleMessageId: number;

      if (session.editingPostId) {
        // Edit session: source info comes from stored forwardInfo
        const fwd = session.editingOriginalForward!;
        sourceChatId = fwd.chatId;
        singleMessageId = fwd.messageId;
        const bulkIds = fwd.replyChainMessageIds ?? fwd.mediaGroupMessageIds ?? null;
        bulkMessageIds = (bulkIds?.length ?? 0) > 1 ? bulkIds! : null;
      } else {
        sourceChatId = session.originalMessage!.chat.id;
        singleMessageId = session.originalMessage!.message_id;
        const replyChain = session.replyChainMessages;
        const mediaGroup = session.mediaGroupMessages;
        const bulkMessages =
          (replyChain?.length ?? 0) > 1 ? replyChain :
          (mediaGroup?.length ?? 0) > 1 ? mediaGroup :
          null;
        bulkMessageIds = bulkMessages ? bulkMessages.map((msg) => msg.message_id) : null;
      }

      if (bulkMessageIds) {
        try {
          const result = (await this.api.raw.forwardMessages({
            chat_id: userId,
            from_chat_id: sourceChatId,
            message_ids: bulkMessageIds,
          })) as Array<{ message_id: number }>;
          previewMessageIds.push(...result.map((r) => r.message_id));
          logger.debug(`Forwarded ${bulkMessageIds.length} messages to user ${userId} for preview`);
        } catch (error) {
          logger.error('Failed to forward messages for preview, falling back to placeholder:', error);
        }
      } else {
        try {
          const result = await this.api.forwardMessage(userId, sourceChatId, singleMessageId);
          previewMessageIds.push(result.message_id);
          logger.debug(`Forwarded single message ${singleMessageId} to user ${userId} for preview`);
        } catch (error) {
          logger.error('Failed to forward single message for preview, falling back to placeholder:', error);
        }
      }

      // Fallback placeholder if forwarding failed
      if (previewMessageIds.length === 0) {
        const count = bulkMessageIds?.length ?? 1;
        const fallbackContent: MessageContent = {
          type: 'text',
          text: `🧵 Thread of ${count} message${count > 1 ? 's' : ''} will be forwarded (preview unavailable)`,
        };
        const fallbackId = await this.mediaSender.sendMessage(userId, fallbackContent);
        previewMessageIds.push(fallbackId);
      }
    } else {
```

Also update the transform path's `parseForwardInfo` call to handle edit sessions:

```typescript
      // For transform action (or unknown): use MediaSenderService
      const forwardInfo = session
        ? (session.editingPostId
            ? session.editingOriginalForward
            : parseForwardInfo(session.originalMessage!))
        : undefined;
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/preview/preview-sender.service.ts
git commit -m "feat: handle edit sessions in PreviewSenderService forward path"
```

---

### Task 8: Add Edit button to queue preview action keyboard

**Files:**
- Modify: `src/bot/keyboards/queue-preview-action.keyboard.ts`

- [ ] **Step 1: Add the Edit button**

Replace the file content with:

```typescript
import { InlineKeyboard } from 'grammy';

export function createQueuePreviewActionKeyboard(postId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✏️ Edit', `queue:edit:${postId}`)
    .text('🗑 Delete post', `queue:del:${postId}`)
    .row()
    .text('⬅ Back to queue', 'queue:back');
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/bot/keyboards/queue-preview-action.keyboard.ts
git commit -m "feat: add Edit button to queue preview action keyboard"
```

---

### Task 9: Create edit-keyboards.ts with all edit-flow keyboards

**Files:**
- Create: `src/bot/keyboards/edit-keyboards.ts`
- Test: `src/bot/keyboards/__tests__/edit-keyboards.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/bot/keyboards/__tests__/edit-keyboards.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  createEditChannelSelectKeyboard,
  createEditForwardActionKeyboard,
  createEditTextHandlingKeyboard,
} from '../edit-keyboards.js';

const SID = 'aaaaaaaaaaaaaaaaaaaaaaaa'; // 24-char session ID

describe('createEditChannelSelectKeyboard', () => {
  it('embeds sessionId in callback data', () => {
    const kb = createEditChannelSelectKeyboard(
      [{ channelId: '-100123', channelTitle: 'My Channel' }],
      SID
    );
    const rows = (kb as any).inline_keyboard as Array<Array<{ callback_data: string }>>;
    expect(rows[0][0].callback_data).toBe(`queue:edit:ch:${SID}:-100123`);
  });
});

describe('createEditForwardActionKeyboard', () => {
  it('embeds sessionId in all buttons', () => {
    const kb = createEditForwardActionKeyboard(SID);
    const rows = (kb as any).inline_keyboard as Array<Array<{ callback_data: string }>>;
    const allData = rows.flat().map((b) => b.callback_data);
    expect(allData).toContain(`queue:edit:action:${SID}:quick`);
    expect(allData).toContain(`queue:edit:action:${SID}:transform`);
    expect(allData).toContain(`queue:edit:action:${SID}:forward`);
  });
});

describe('createEditTextHandlingKeyboard', () => {
  it('embeds sessionId in all buttons', () => {
    const kb = createEditTextHandlingKeyboard(SID);
    const rows = (kb as any).inline_keyboard as Array<Array<{ callback_data: string }>>;
    const allData = rows.flat().map((b) => b.callback_data);
    expect(allData).toContain(`queue:edit:text:${SID}:keep`);
    expect(allData).toContain(`queue:edit:text:${SID}:remove`);
    expect(allData).toContain(`queue:edit:text:${SID}:quote`);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- src/bot/keyboards/__tests__/edit-keyboards.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create edit-keyboards.ts**

Create `src/bot/keyboards/edit-keyboards.ts`:

```typescript
import { listCustomTextPresets } from '../../database/models/custom-text-preset.model.js';
import { getNicknameOptions } from '../../shared/helpers/nickname.helper.js';

interface Channel {
  channelId: string;
  channelTitle?: string | null;
}

export function createEditChannelSelectKeyboard(
  channels: Channel[],
  sessionId: string
): object {
  const rows = channels.map((ch) => [
    {
      text: ch.channelTitle ?? ch.channelId,
      callback_data: `queue:edit:ch:${sessionId}:${ch.channelId}`,
    },
  ]);
  return { inline_keyboard: rows };
}

export function createEditForwardActionKeyboard(sessionId: string): object {
  return {
    inline_keyboard: [
      [{ text: '⚡ Quick post', callback_data: `queue:edit:action:${sessionId}:quick`, style: 'primary' }],
      [
        { text: '✨ Transform', callback_data: `queue:edit:action:${sessionId}:transform` },
        { text: '➡️ Forward', callback_data: `queue:edit:action:${sessionId}:forward` },
      ],
    ],
  };
}

export function createEditTextHandlingKeyboard(sessionId: string): object {
  return {
    inline_keyboard: [
      [
        { text: '📝 Keep', callback_data: `queue:edit:text:${sessionId}:keep` },
        { text: '🗑 Remove', callback_data: `queue:edit:text:${sessionId}:remove` },
        { text: '💬 Quote', callback_data: `queue:edit:text:${sessionId}:quote` },
      ],
    ],
  };
}

export function createEditNicknameKeyboard(
  nicknames: Array<{ userId: number; nickname: string }>,
  sessionId: string
): object {
  const rows: object[][] = [
    [{ text: 'No attribution', callback_data: `queue:edit:nickname:${sessionId}:none`, style: 'primary' }],
  ];
  nicknames.forEach((n) => {
    rows.push([{ text: n.nickname, callback_data: `queue:edit:nickname:${sessionId}:${n.userId}` }]);
  });
  return { inline_keyboard: rows };
}

export async function createEditCustomTextKeyboard(sessionId: string): Promise<object> {
  const presets = await listCustomTextPresets();
  const rows: object[][] = presets.map((p) => [
    { text: p.label, callback_data: `queue:edit:custom:preset:${sessionId}:${p._id}` },
  ]);
  rows.push([
    { text: 'Skip', callback_data: `queue:edit:custom:${sessionId}:skip`, style: 'primary' },
    { text: '✍️ Add text', callback_data: `queue:edit:custom:${sessionId}:add` },
  ]);
  return { inline_keyboard: rows };
}

```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- src/bot/keyboards/__tests__/edit-keyboards.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Build**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/bot/keyboards/edit-keyboards.ts src/bot/keyboards/__tests__/edit-keyboards.test.ts
git commit -m "feat: add edit-flow keyboards"
```

---

### Task 10: Export queuePreviewStateMap from callback.handler.ts

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`

`queue-edit.handler.ts` needs to access the queue preview state (for cleaning up preview messages when "Edit" is clicked).

- [ ] **Step 1: Export the map**

In `callback.handler.ts`, change line 56:

```typescript
// Before:
const queuePreviewStateMap = new Map<number, QueuePreviewState>();

// After:
export const queuePreviewStateMap = new Map<number, QueuePreviewState>();
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/bot/handlers/callback.handler.ts
git commit -m "feat: export queuePreviewStateMap for queue-edit handler"
```

---

### Task 11: Create queue-edit.handler.ts

**Files:**
- Create: `src/bot/handlers/queue-edit.handler.ts`

This file registers all `queue:edit:*` callbacks. Each callback fetches the session by ID (no `reply_to_message` needed).

- [ ] **Step 1: Create the handler**

Create `src/bot/handlers/queue-edit.handler.ts`:

```typescript
import { Context } from 'grammy';
import { bot } from '../bot.js';
import { DIContainer } from '../../shared/di/container.js';
import type { SessionService } from '../../core/session/session.service.js';
import { SessionState } from '../../shared/constants/flow-states.js';
import { getNextState } from '../../core/session/session-state-machine.js';
import { ScheduledPostRepository } from '../../database/repositories/scheduled-post.repository.js';
import { getActivePostingChannels } from '../../database/models/posting-channel.model.js';
import { transformerService } from '../../services/transformer.service.js';
import { PreviewGeneratorService } from '../../core/preview/preview-generator.service.js';
import { PreviewSenderService } from '../../core/preview/preview-sender.service.js';
import { CustomTextPreset } from '../../database/models/custom-text-preset.model.js';
import { findNicknameByUserId, getNicknameOptions } from '../../shared/helpers/nickname.helper.js';
import { ErrorMessages } from '../../shared/constants/error-messages.js';
import { logger } from '../../utils/logger.js';
import { queuePreviewStateMap } from './callback.handler.js';
import {
  createEditChannelSelectKeyboard,
  createEditForwardActionKeyboard,
  createEditTextHandlingKeyboard,
  createEditNicknameKeyboard,
  createEditCustomTextKeyboard,
} from '../keyboards/edit-keyboards.js';

let sessionService: SessionService;
function getSessionService(): SessionService | undefined {
  if (!sessionService && DIContainer.has('SessionService')) {
    sessionService = DIContainer.resolve<SessionService>('SessionService');
  }
  return sessionService;
}

// ── Entry point ──────────────────────────────────────────────────────────────

// queue:edit:{postId} — start re-flow for an existing scheduled post
bot.callbackQuery(/^queue:edit:([a-f0-9]{24})$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const postId = (ctx.match as RegExpExecArray)[1];
    const userId = ctx.from?.id;
    if (!userId) return;

    const repository = new ScheduledPostRepository();
    const post = await repository.findById(postId);
    if (!post) {
      await ctx.answerCallbackQuery({ text: '❌ Post already published or deleted', show_alert: true });
      return;
    }

    // Clean up queue preview messages
    const state = queuePreviewStateMap.get(userId);
    if (state) {
      for (const msgId of state.previewMessageIds) {
        await ctx.api.deleteMessage(userId, msgId).catch(() => {});
      }
      queuePreviewStateMap.delete(userId);
    }
    await ctx.deleteMessage().catch(() => {});

    const sessionSvc = getSessionService();
    if (!sessionSvc) {
      await ctx.reply('❌ Service unavailable. Please try again.');
      return;
    }

    const session = await sessionSvc.createForEdit(userId, post);
    const sessionId = session._id.toString();

    const channels = await getActivePostingChannels();
    if (channels.length === 0) {
      await ctx.reply('⚠️ No posting channels configured.');
      return;
    }

    const keyboard = createEditChannelSelectKeyboard(channels, sessionId);
    await ctx.api.sendMessage(userId, '📍 Select target channel:', {
      reply_markup: keyboard as any,
    });

    logger.debug(`Edit session ${sessionId} started for user ${userId}, post ${postId}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error starting edit.', 'queue:edit entry');
  }
});

// ── Channel selection ─────────────────────────────────────────────────────────

// queue:edit:ch:{sessionId}:{channelId}
bot.callbackQuery(/^queue:edit:ch:([^:]+):(-?\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const [, sessionId, channelId] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    const isGreenListed = await transformerService.shouldAutoForward(session.editingOriginalForward);
    const isRedListed = session.editingOriginalForward?.fromChannelId
      ? await transformerService.isRedListed(String(session.editingOriginalForward.fromChannelId))
      : false;
    const rawContent = session.editingRawContent!;
    const hasText = !!(rawContent.text && rawContent.text.trim().length > 0);
    const isPoll = rawContent.type === 'poll';

    await sessionSvc!.updateState(sessionId, SessionState.CHANNEL_SELECT, {
      selectedChannel: channelId,
    });

    // Polls always forward
    if (isPoll) {
      await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, { selectedAction: 'forward' });
      await showEditPreview(ctx, sessionId);
      return;
    }

    // Green-listed: auto-forward
    if (isGreenListed) {
      await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, { selectedAction: 'forward' });
      await showEditPreview(ctx, sessionId);
      return;
    }

    // Red-listed: auto-transform
    if (isRedListed) {
      await sessionSvc!.update(sessionId, { selectedAction: 'transform' });
      if (hasText) {
        await ctx.editMessageText('How should the text be handled?', {
          reply_markup: createEditTextHandlingKeyboard(sessionId) as any,
        });
      } else {
        await showEditNicknameStep(ctx, sessionId);
      }
      return;
    }

    // Standard: show transform/forward options
    await ctx.editMessageText(
      'Choose how to post this message:\n⚡ <b>Quick post</b> — transform, no attribution, no extra text',
      { reply_markup: createEditForwardActionKeyboard(sessionId) as any, parse_mode: 'HTML' }
    );
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting channel.', 'queue:edit:ch');
  }
});

// ── Action selection ──────────────────────────────────────────────────────────

// queue:edit:action:{sessionId}:(transform|forward|quick)
bot.callbackQuery(/^queue:edit:action:([^:]+):(transform|forward|quick)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const [, sessionId, action] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    const rawContent = session.editingRawContent!;
    const hasText = !!(rawContent.text && rawContent.text.trim().length > 0);

    if (action === 'quick') {
      // Quick: transform + remove text + auto-nickname + no custom text
      const autoNickname = session.editingOriginalForward?.fromUserId
        ? await findNicknameByUserId(session.editingOriginalForward.fromUserId) ?? null
        : null;
      await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, {
        selectedAction: 'transform',
        textHandling: 'remove',
        selectedNickname: autoNickname,
        customText: undefined,
      });
      await showEditPreview(ctx, sessionId);
      return;
    }

    if (action === 'forward') {
      await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, { selectedAction: 'forward' });
      await showEditPreview(ctx, sessionId);
      return;
    }

    // transform
    await sessionSvc!.update(sessionId, { selectedAction: 'transform' });
    if (hasText) {
      await ctx.editMessageText('How should the text be handled?', {
        reply_markup: createEditTextHandlingKeyboard(sessionId) as any,
      });
    } else {
      await showEditNicknameStep(ctx, sessionId);
    }
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting action.', 'queue:edit:action');
  }
});

// ── Text handling ─────────────────────────────────────────────────────────────

// queue:edit:text:{sessionId}:(keep|remove|quote)
bot.callbackQuery(/^queue:edit:text:([^:]+):(keep|remove|quote)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const [, sessionId, textHandling] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    await sessionSvc!.update(sessionId, {
      textHandling: textHandling as 'keep' | 'remove' | 'quote',
    });

    await showEditNicknameStep(ctx, sessionId);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting text handling.', 'queue:edit:text');
  }
});

// ── Nickname selection ────────────────────────────────────────────────────────

// queue:edit:nickname:{sessionId}:{userId|none}
bot.callbackQuery(/^queue:edit:nickname:([^:]+):([^:]+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const [, sessionId, nicknameKey] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    let selectedNickname: string | null = null;
    if (nicknameKey !== 'none') {
      const userId = parseInt(nicknameKey, 10);
      if (!isNaN(userId)) {
        selectedNickname = await findNicknameByUserId(userId);
      }
    }

    await sessionSvc!.update(sessionId, { selectedNickname });

    // Show custom text keyboard
    const keyboard = await createEditCustomTextKeyboard(sessionId);
    await ctx.editMessageText('Do you want to add custom text to this post?', {
      reply_markup: keyboard as any,
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting nickname.', 'queue:edit:nickname');
  }
});

// ── Custom text ───────────────────────────────────────────────────────────────

// queue:edit:custom:{sessionId}:(add|skip)
bot.callbackQuery(/^queue:edit:custom:([^:]+):(add|skip)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const [, sessionId, choice] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    if (choice === 'skip') {
      await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, { customText: undefined });
      await showEditPreview(ctx, sessionId);
    } else {
      await sessionSvc!.updateState(sessionId, SessionState.CUSTOM_TEXT, {
        waitingForCustomText: true,
      });
      await ctx.editMessageText(
        '✍️ Reply to this message with your custom text.\n\nThis text will be added at the beginning of your post.'
      );
    }
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error with custom text.', 'queue:edit:custom');
  }
});

// queue:edit:custom:preset:{sessionId}:{presetId}
bot.callbackQuery(/^queue:edit:custom:preset:([^:]+):(.+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery();
    const [, sessionId, presetId] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    const preset = await CustomTextPreset.findById(presetId).lean();
    if (!preset) {
      await ctx.editMessageText('❌ Preset not found. It may have been deleted.');
      return;
    }

    await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, { customText: preset.text });
    await showEditPreview(ctx, sessionId);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting preset.', 'queue:edit:custom:preset');
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function showEditPreview(ctx: Context, sessionId: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const sessionSvc = getSessionService();
  const session = await sessionSvc?.findById(sessionId);
  if (!session) {
    await ctx.reply('❌ Edit session expired. Use /queue to start again.');
    return;
  }

  try {
    const previewGenerator = new PreviewGeneratorService();
    const previewContent = await previewGenerator.generatePreview(session);

    const previewSender = new PreviewSenderService(ctx.api);
    await previewSender.sendPreview(userId, previewContent, sessionId);

    await ctx.deleteMessage().catch(() => {});
    await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, {});
    logger.debug(`Edit preview shown for session ${sessionId}`);
  } catch (error) {
    logger.error('Error showing edit preview:', error);
    await ctx.editMessageText('❌ Preview generation failed. Please try again.');
  }
}

async function showEditNicknameStep(ctx: Context, sessionId: string): Promise<void> {
  // Auto-select nickname if the source user has one
  const sessionSvc = getSessionService();
  const session = await sessionSvc?.findById(sessionId);
  if (!session) return;

  const fromUserId = session.editingOriginalForward?.fromUserId;
  if (fromUserId) {
    const autoNickname = await findNicknameByUserId(fromUserId);
    if (autoNickname) {
      await sessionSvc!.update(sessionId, { selectedNickname: autoNickname });
      const keyboard = await createEditCustomTextKeyboard(sessionId);
      await ctx.editMessageText('Do you want to add custom text to this post?', {
        reply_markup: keyboard as any,
      });
      return;
    }
  }

  const options = await getNicknameOptions();
  const keyboard = createEditNicknameKeyboard(options, sessionId);
  await ctx.editMessageText('Who should be credited for this post?', {
    reply_markup: keyboard as any,
  });
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/bot/handlers/queue-edit.handler.ts
git commit -m "feat: add queue-edit handler with full re-flow callbacks"
```

---

### Task 12: Add edit branches to preview callbacks + import handler

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `src/index.ts`

Three existing callbacks need to branch on `session.editingPostId`: `preview:schedule`, `preview:back`, `preview:cancel`.

- [ ] **Step 1: Add imports to callback.handler.ts**

Add to the imports block at the top of `callback.handler.ts`:

```typescript
import { createEditChannelSelectKeyboard } from '../keyboards/edit-keyboards.js';
```

- [ ] **Step 2: Add edit branch to preview:schedule**

At the top of the `preview:schedule` callback handler, right after the `session` is fetched and confirmed non-null, add:

```typescript
    // ── Edit-session confirm ──────────────────────────────────────────────
    if (session.editingPostId) {
      const {
        editingPostId,
        editingOriginalChannelId,
        editingOriginalScheduledTime,
        editingRawContent,
        editingOriginalForward,
      } = session;

      const sameChannel = session.selectedChannel === editingOriginalChannelId;
      const repository = new ScheduledPostRepository();

      if (sameChannel) {
        let newContent = editingRawContent!;
        if (session.selectedAction === 'transform') {
          const transformedText = await transformerService.transformMessage(
            editingRawContent!.text ?? '',
            editingOriginalForward!,
            'transform',
            session.textHandling ?? 'keep',
            session.selectedNickname,
            session.customText
          );
          newContent = { ...editingRawContent!, text: transformedText };
        }

        await repository.updatePost(editingPostId!, {
          content: newContent,
          action: session.selectedAction ?? 'transform',
          rawContent: editingRawContent!,
          textHandling: session.textHandling,
          selectedNickname: session.selectedNickname,
          customText: session.customText,
        });

        if (fromId) await deletePreviewMessages(ctx, fromId, session);
        await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
        await sessionSvc.complete(sessionKey);

        const channelDoc = await PostingChannel.findOne({ channelId: editingOriginalChannelId }).lean();
        const channelLabel = channelDoc?.channelTitle ?? channelDoc?.channelUsername ?? editingOriginalChannelId;
        await ctx.reply(
          `✅ Post updated!\nTarget: ${channelLabel}\nScheduled for: ${formatSlotTime(editingOriginalScheduledTime!)}`
        );
      } else {
        // Different channel: cascade-delete + schedule new
        await queueService.deleteAndCascade(editingPostId!);

        const newChannelId = session.selectedChannel!;
        const { scheduledTime } =
          session.selectedAction === 'forward'
            ? await postScheduler.scheduleForwardPost({
                targetChannelId: newChannelId,
                forwardInfo: editingOriginalForward!,
                content: editingRawContent!,
              })
            : await postScheduler.scheduleTransformPost({
                targetChannelId: newChannelId,
                forwardInfo: editingOriginalForward!,
                content: editingRawContent!,
                textHandling: session.textHandling ?? 'keep',
                selectedNickname: session.selectedNickname,
                customText: session.customText,
              });

        if (fromId) await deletePreviewMessages(ctx, fromId, session);
        await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
        await sessionSvc.complete(sessionKey);

        const channelDoc = await PostingChannel.findOne({ channelId: newChannelId }).lean();
        const channelLabel = channelDoc?.channelTitle ?? channelDoc?.channelUsername ?? newChannelId;
        await ctx.reply(
          `✅ Moved to ${channelLabel}\nScheduled for: ${formatSlotTime(scheduledTime)}`
        );
      }

      logger.info(`Edit confirmed for session ${sessionKey}`);
      return;
    }
    // ── End edit-session confirm ──────────────────────────────────────────
```

- [ ] **Step 3: Add edit branch to preview:back**

In the `preview:back` callback, after preview messages are deleted and control message removed, add before the existing "Reset session" block:

```typescript
    // Edit sessions: re-send channel selection instead of reply-based channel select
    if (session.editingPostId) {
      await sessionSvc.updateState(sessionKey, SessionState.CHANNEL_SELECT, {
        selectedChannel: session.editingOriginalChannelId,
        selectedAction: undefined,
        textHandling: undefined,
        selectedNickname: undefined,
        customText: undefined,
        previewMessageId: undefined,
        previewMessageIds: undefined,
      });

      const channels = await getActivePostingChannels();
      if (channels.length === 0) {
        await ctx.reply('⚠️ No posting channels configured.');
        return;
      }
      const keyboard = createEditChannelSelectKeyboard(channels, sessionKey);
      await ctx.api.sendMessage(fromId!, '📍 Select target channel:', {
        reply_markup: keyboard as any,
      });

      logger.info(`Edit back: re-showing channel select for session ${sessionKey}`);
      return;
    }
```

- [ ] **Step 4: Add edit branch to preview:cancel**

In the `preview:cancel` callback, after preview messages are deleted and control message removed, add before `sessionSvc.complete(sessionKey)`:

```typescript
    // For edit sessions, original post stays untouched — just clean up the edit session
    if (session.editingPostId) {
      await sessionSvc.complete(sessionKey);
      await ctx.reply('Edit cancelled.');
      logger.info(`Edit cancelled for session ${sessionKey}`);
      return;
    }
```

- [ ] **Step 5: Import queue-edit handler in index.ts**

In `src/index.ts`, add after the existing handler imports:

```typescript
import './bot/handlers/queue-edit.handler.js';
```

- [ ] **Step 6: Build**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 7: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/bot/handlers/callback.handler.ts src/index.ts
git commit -m "feat: wire queue post editing — edit branches in preview callbacks"
```

---

### Task 13: Manual smoke test

- [ ] **Step 1: Start the bot locally**

```bash
npm run dev
```

- [ ] **Step 2: Schedule a test post**

Forward any message to the bot → go through the normal scheduling flow → confirm "Post scheduled!"

- [ ] **Step 3: Open the queue**

Send `/queue` → select the channel → the post should appear with the `👁` button.

- [ ] **Step 4: Preview the post**

Click `👁` → preview appears with the control message showing `✏️ Edit | 🗑 Delete post | ⬅ Back to queue`.

- [ ] **Step 5: Test Edit — same channel**

Click `✏️ Edit` → channel selection appears → select the same channel → go through action/text/nickname/custom text → confirm → message says "✅ Post updated!" → `/queue` should show the post at the same time slot.

- [ ] **Step 6: Test Edit — different channel**

Repeat but select a different channel at the channel selection step → confirm → message says "✅ Moved to [channel] …" → old channel queue should be empty, new channel queue should have the post.

- [ ] **Step 7: Test Edit — Back from preview**

Start edit → reach preview → click Back → channel selection appears again → proceed through flow normally.

- [ ] **Step 8: Test Edit — Cancel**

Start edit → reach preview → click Cancel → "Edit cancelled." → original post still in queue.

- [ ] **Step 9: Final commit check**

```bash
npm run build && npm test
```

Expected: build and all tests pass.

- [ ] **Step 10: Push**

```bash
git push
```
