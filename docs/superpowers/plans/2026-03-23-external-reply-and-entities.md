# External Reply Support & Entity/HTML Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Telegram text formatting through the transform flow, and schedule posts that reply to messages in other chats.

**Architecture:** Two self-contained fixes. (1) `extractMessageContent` converts entities to HTML at extraction time — all downstream paths already use `parse_mode: 'HTML'`. (2) `parseForwardInfo` detects `external_reply` and populates `replyParameters`; `PostPublisherService` passes those parameters to the Telegram API when publishing; the rest of the flow (attribution, green/red list, nickname) works unchanged.

**Tech Stack:** TypeScript, Grammy (grammY) bot framework, MongoDB/Mongoose, Vitest for unit tests. All Telegram send methods accept typed `reply_parameters` (no `as any` needed).

**Spec:** `docs/superpowers/specs/2026-03-23-external-reply-and-entities-design.md`

---

## File Map

| File | Role in this change |
|------|---------------------|
| `src/utils/entities-to-html.ts` | Add `blockquote` and `expandable_blockquote` entity tags |
| `src/utils/__tests__/entities-to-html.test.ts` | **Create** — unit tests for entity conversion |
| `src/utils/__tests__/message-parser.test.ts` | **Create** — unit tests for `parseForwardInfo` with `external_reply` |
| `src/bot/handlers/forward.handler.ts` | (1) `extractMessageContent`: use `entitiesToHtml` for text/captions; (2) custom-text filter: add `external_reply` guard |
| `src/types/message.types.ts` | Add `replyParameters` field to `ForwardInfo` |
| `src/utils/message-parser.ts` | Handle `message.external_reply` in `parseForwardInfo` |
| `src/services/transformer.service.ts` | Early-return in `shouldAutoForward` when `replyParameters` is set |
| `src/database/models/scheduled-post.model.ts` | Add `replyParameters` sub-fields to `originalForward` Mongoose schema |
| `src/core/sending/media-sender.service.ts` | Accept optional `replyParameters`, pass as `reply_parameters` in API calls |
| `src/core/posting/post-publisher.service.ts` | Pass `post.originalForward.replyParameters` to `mediaSender.sendMessage` |

---

## Task 1: Add `blockquote` entity support to `entitiesToHtml`

**Files:**
- Modify: `src/utils/entities-to-html.ts`
- Create: `src/utils/__tests__/entities-to-html.test.ts`

- [ ] **Step 1.1: Create test file**

```typescript
// src/utils/__tests__/entities-to-html.test.ts
import { describe, it, expect } from 'vitest';
import { entitiesToHtml } from '../entities-to-html.js';
import type { MessageEntity } from 'grammy/types';

describe('entitiesToHtml', () => {
  it('returns escaped plain text when no entities', () => {
    expect(entitiesToHtml('hello <world>')).toBe('hello &lt;world&gt;');
  });

  it('wraps bold entity', () => {
    const entities: MessageEntity[] = [{ type: 'bold', offset: 0, length: 5 }];
    expect(entitiesToHtml('hello world', entities)).toBe('<b>hello</b> world');
  });

  it('wraps blockquote entity', () => {
    const entities: MessageEntity[] = [{ type: 'blockquote', offset: 0, length: 5 }];
    expect(entitiesToHtml('hello', entities)).toBe('<blockquote>hello</blockquote>');
  });

  it('wraps expandable_blockquote entity', () => {
    const entities: MessageEntity[] = [{ type: 'expandable_blockquote', offset: 0, length: 5 }];
    expect(entitiesToHtml('hello', entities)).toBe('<blockquote expandable>hello</blockquote>');
  });

  it('escapes HTML special chars inside entity spans', () => {
    const entities: MessageEntity[] = [{ type: 'bold', offset: 0, length: 7 }];
    expect(entitiesToHtml('a < b & c', entities)).toBe('<b>a &lt; b &amp;</b> c');
  });
});
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npx vitest run src/utils/__tests__/entities-to-html.test.ts
```

Expected: `blockquote` and `expandable_blockquote` tests fail (no handler), others may pass.

- [ ] **Step 1.3: Add `blockquote` and `expandable_blockquote` to `openTag` and `closeTag`**

In `src/utils/entities-to-html.ts`, add cases to both switch statements — insert after the `'spoiler'` cases:

```typescript
// In openTag():
case 'blockquote':
  return '<blockquote>';
case 'expandable_blockquote':
  return '<blockquote expandable>';

// In closeTag():
case 'blockquote':
  return '</blockquote>';
case 'expandable_blockquote':
  return '</blockquote>';
```

- [ ] **Step 1.4: Run tests to confirm they pass**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npx vitest run src/utils/__tests__/entities-to-html.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 1.5: Build check**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 1.6: Commit**

```bash
git add src/utils/entities-to-html.ts src/utils/__tests__/entities-to-html.test.ts
git commit -m "feat: add blockquote and expandable_blockquote entity support to entitiesToHtml"
```

---

## Task 2: Preserve entities in `extractMessageContent`

**Files:**
- Modify: `src/bot/handlers/forward.handler.ts`

`extractMessageContent` currently returns raw `message.text` / `message.caption` strings. Replace each with `entitiesToHtml(text, entities)`. The `entitiesToHtml` import already exists at line 15 of `forward.handler.ts`.

- [ ] **Step 2.1: Update `extractMessageContent` — text message**

Find this block (around line 492):
```typescript
if ('text' in message && message.text) {
  return {
    type: 'text',
    text: message.text,
  };
}
```

Replace with:
```typescript
if ('text' in message && message.text) {
  return {
    type: 'text',
    text: entitiesToHtml(message.text, message.entities),
  };
}
```

- [ ] **Step 2.2: Update `extractMessageContent` — photo**

Find:
```typescript
return {
  type: 'photo',
  fileId: photo.file_id,
  text: message.caption,
};
```

Replace with:
```typescript
return {
  type: 'photo',
  fileId: photo.file_id,
  text: message.caption ? entitiesToHtml(message.caption, message.caption_entities) : undefined,
};
```

- [ ] **Step 2.3: Update `extractMessageContent` — video, document, animation**

Apply the same caption pattern to all three. Find:
```typescript
return {
  type: 'video',
  fileId: message.video.file_id,
  text: message.caption,
};
```
Replace with:
```typescript
return {
  type: 'video',
  fileId: message.video.file_id,
  text: message.caption ? entitiesToHtml(message.caption, message.caption_entities) : undefined,
};
```

Repeat for `document` and `animation` — same pattern each time.

- [ ] **Step 2.4: Update `extractMessageContent` — media group caption**

Find:
```typescript
const caption = mediaGroupMessages.find((msg) => msg.caption)?.caption;
```

Replace with:
```typescript
const captionMsg = mediaGroupMessages.find((msg) => msg.caption);
const caption = captionMsg?.caption
  ? entitiesToHtml(captionMsg.caption, captionMsg.caption_entities)
  : undefined;
```

- [ ] **Step 2.5: Build check**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 2.6: Commit**

```bash
git add src/bot/handlers/forward.handler.ts
git commit -m "fix: preserve entity formatting in extractMessageContent via entitiesToHtml"
```

---

## Task 3: Add `replyParameters` to `ForwardInfo` and handle `external_reply` in parser

**Files:**
- Modify: `src/types/message.types.ts`
- Modify: `src/utils/message-parser.ts`
- Create: `src/utils/__tests__/message-parser.test.ts`

- [ ] **Step 3.1: Add `replyParameters` to `ForwardInfo`**

In `src/types/message.types.ts`, add to the `ForwardInfo` interface after `replyChainMessageIds`:

```typescript
replyParameters?: { chatId: number; messageId: number }; // For cross-chat reply posting
```

- [ ] **Step 3.2: Write failing tests for `parseForwardInfo` with `external_reply`**

```typescript
// src/utils/__tests__/message-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseForwardInfo } from '../message-parser.js';
import type { Message } from 'grammy/types';

function makeBase(extra: Partial<Message> = {}): Message {
  return {
    message_id: 100,
    date: 0,
    chat: { id: 999, type: 'private' },
    ...extra,
  } as Message;
}

describe('parseForwardInfo — external_reply', () => {
  it('returns base info for plain non-forwarded message', () => {
    const msg = makeBase();
    const result = parseForwardInfo(msg);
    expect(result.messageId).toBe(100);
    expect(result.chatId).toBe(999);
    expect(result.fromChannelId).toBeUndefined();
    expect(result.replyParameters).toBeUndefined();
  });

  it('extracts channel origin from external_reply', () => {
    const msg = makeBase({
      external_reply: {
        origin: {
          type: 'channel',
          date: 0,
          chat: { id: -1001, type: 'channel', title: 'Test Chan', username: 'testchan' },
          message_id: 42,
        },
        chat: { id: -1001, type: 'channel', title: 'Test Chan', username: 'testchan' },
        message_id: 42,
      },
    });

    const result = parseForwardInfo(msg);
    expect(result.fromChannelId).toBe(-1001);
    expect(result.fromChannelTitle).toBe('Test Chan');
    expect(result.fromChannelUsername).toBe('testchan');
    expect(result.messageLink).toBe('https://t.me/testchan/42');
    expect(result.replyParameters).toEqual({ chatId: -1001, messageId: 42 });
  });

  it('extracts user origin from external_reply', () => {
    const msg = makeBase({
      external_reply: {
        origin: {
          type: 'user',
          date: 0,
          sender_user: { id: 777, is_bot: false, first_name: 'Alice', username: 'alice' },
        },
        chat: { id: -1002, type: 'supergroup', title: 'Group' },
        message_id: 55,
      },
    });

    const result = parseForwardInfo(msg);
    expect(result.fromUserId).toBe(777);
    expect(result.fromUsername).toBe('alice');
    expect(result.replyParameters).toEqual({ chatId: -1002, messageId: 55 });
  });

  it('omits replyParameters when external_reply has no chat/message_id', () => {
    const msg = makeBase({
      external_reply: {
        origin: { type: 'hidden_user', date: 0, sender_user_name: 'Hidden' },
        // no chat, no message_id
      },
    });

    const result = parseForwardInfo(msg);
    expect(result.replyParameters).toBeUndefined();
  });
});
```

- [ ] **Step 3.3: Run tests to confirm they fail**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npx vitest run src/utils/__tests__/message-parser.test.ts
```

Expected: external_reply tests fail (no handler in `parseForwardInfo` yet).

- [ ] **Step 3.4: Add `external_reply` handling to `parseForwardInfo`**

In `src/utils/message-parser.ts`, after the `if (!message.forward_origin)` block (currently returns `base` for non-forwarded messages), add the `external_reply` check **inside** that block, before the final `return base`:

```typescript
export function parseForwardInfo(message: Message): ForwardInfo {
  const base: ForwardInfo = {
    messageId: message.message_id,
    chatId: message.chat.id,
  };

  // If not a forward, check for external_reply (cross-chat reply, Bot API 7.0)
  if (!message.forward_origin) {
    if (message.external_reply) {
      const ext = message.external_reply;
      const replyParameters =
        ext.chat && ext.message_id !== undefined
          ? { chatId: ext.chat.id, messageId: ext.message_id }
          : undefined;

      const origin = ext.origin;

      if (origin.type === 'channel') {
        const channelUsername = 'username' in origin.chat ? origin.chat.username : undefined;
        return {
          ...base,
          fromChannelId: origin.chat.id,
          fromChannelTitle: origin.chat.title,
          ...(channelUsername
            ? {
                fromChannelUsername: channelUsername,
                messageLink: `https://t.me/${channelUsername}/${origin.message_id}`,
              }
            : {}),
          ...(replyParameters ? { replyParameters } : {}),
        };
      }

      if (origin.type === 'user') {
        return {
          ...base,
          fromUserId: origin.sender_user.id,
          ...(origin.sender_user.username ? { fromUsername: origin.sender_user.username } : {}),
          ...(replyParameters ? { replyParameters } : {}),
        };
      }

      return { ...base, ...(replyParameters ? { replyParameters } : {}) };
    }

    logger.debug('Non-forwarded message, using original message info');
    return base;
  }

  // ... rest of forward_origin handling unchanged
```

- [ ] **Step 3.5: Run tests to confirm they pass**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npx vitest run src/utils/__tests__/message-parser.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 3.6: Build check**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 3.7: Commit**

```bash
git add src/types/message.types.ts src/utils/message-parser.ts src/utils/__tests__/message-parser.test.ts
git commit -m "feat: extract external_reply origin and replyParameters in parseForwardInfo"
```

---

## Task 4: Guard `shouldAutoForward` against external replies

**Files:**
- Modify: `src/services/transformer.service.ts`

External replies can have a `fromChannelId` (from `external_reply.origin`), which would cause `shouldAutoForward` to return `true` for green-listed channels. We must never auto-forward an external reply — the content to post is the user's own text, not the channel post.

- [ ] **Step 4.1: Add early return to `shouldAutoForward`**

In `src/services/transformer.service.ts`, update `shouldAutoForward`:

```typescript
export async function shouldAutoForward(forwardInfo: ForwardInfo): Promise<boolean> {
  if (forwardInfo.replyParameters) return false; // external reply — content is user's text, not the channel post
  if (!forwardInfo.fromChannelId) return false;

  const channelId = String(forwardInfo.fromChannelId);
  if (await channelListRepo.isGreenListed(channelId)) return true;

  const adminedChannel = await PostingChannel.findOne({ channelId, isActive: true }).lean();
  return adminedChannel !== null;
}
```

- [ ] **Step 4.2: Build check**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 4.3: Commit**

```bash
git add src/services/transformer.service.ts
git commit -m "fix: prevent auto-forward for external-reply messages in shouldAutoForward"
```

---

## Task 5: Add `replyParameters` guard to custom-text filter

**Files:**
- Modify: `src/bot/handlers/forward.handler.ts`

The custom-text input filter intercepts text messages that are replies to bot messages (waiting for the user to type their custom post text). A cross-chat reply message normally has no `reply_to_message`, but as a safety guard we explicitly exclude messages with `external_reply`.

- [ ] **Step 5.1: Update the custom-text filter predicate**

In `src/bot/handlers/forward.handler.ts`, find the filter at line 67:

```typescript
bot.on('message:text').filter((ctx) => !!ctx.message?.reply_to_message, async (ctx: Context, next: NextFunction) => {
```

Replace the filter predicate only:

```typescript
bot.on('message:text').filter(
  (ctx) => !!ctx.message?.reply_to_message && !ctx.message?.external_reply,
  async (ctx: Context, next: NextFunction) => {
```

- [ ] **Step 5.2: Build check**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 5.3: Commit**

```bash
git add src/bot/handlers/forward.handler.ts
git commit -m "fix: exclude external_reply messages from custom-text input filter"
```

---

## Task 6: Update MongoDB schema for `replyParameters`

**Files:**
- Modify: `src/database/models/scheduled-post.model.ts`

Mongoose ignores unknown fields by default (`strict: true`). Without this change, `replyParameters` would be silently dropped when saving a post.

- [ ] **Step 6.1: Add `replyParameters` to `originalForward` sub-schema**

In `src/database/models/scheduled-post.model.ts`, in the `originalForward` sub-schema object (after `replyChainMessageIds`), add:

```typescript
replyParameters: {
  chatId: Number,
  messageId: Number,
},
```

The full `originalForward` block should look like:
```typescript
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
```

- [ ] **Step 6.2: Build check**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6.3: Commit**

```bash
git add src/database/models/scheduled-post.model.ts
git commit -m "feat: add replyParameters to ScheduledPost.originalForward Mongoose schema"
```

---

## Task 7: Add `replyParameters` to `MediaSenderService`

**Files:**
- Modify: `src/core/sending/media-sender.service.ts`

Add an optional third parameter to `sendMessage` and each individual send method. When provided, include `reply_parameters: { message_id, chat_id }` in the Telegram API call. Grammy's send methods have `reply_parameters` as a typed optional — no `as any` needed.

- [ ] **Step 7.1: Update `sendMessage` and all individual send methods**

Replace the entire `MediaSenderService` class body in `src/core/sending/media-sender.service.ts`:

```typescript
import { Api } from 'grammy';
import type { MessageContent, MediaGroupItem } from '../../types/message.types.js';

type ReplyParams = { chatId: number; messageId: number };

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
  async sendMessage(
    chatId: number | string,
    content: MessageContent,
    replyParameters?: ReplyParams
  ): Promise<number> {
    switch (content.type) {
      case 'photo':
        return await this.sendPhoto(chatId, content.fileId!, content.text, replyParameters);
      case 'video':
        return await this.sendVideo(chatId, content.fileId!, content.text, replyParameters);
      case 'document':
        return await this.sendDocument(chatId, content.fileId!, content.text, replyParameters);
      case 'animation':
        return await this.sendAnimation(chatId, content.fileId!, content.text, replyParameters);
      case 'media_group':
        return await this.sendMediaGroup(chatId, content.mediaGroup!, content.text, replyParameters);
      case 'text':
        return await this.sendText(chatId, content.text!, replyParameters);
      default:
        throw new Error(`Unsupported content type: ${(content as unknown as { type: string }).type}`);
    }
  }

  async sendPhoto(
    chatId: number | string,
    fileId: string,
    caption?: string,
    replyParameters?: ReplyParams
  ): Promise<number> {
    const result = await this.api.sendPhoto(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
      ...(replyParameters
        ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
        : {}),
    });
    return result.message_id;
  }

  async sendVideo(
    chatId: number | string,
    fileId: string,
    caption?: string,
    replyParameters?: ReplyParams
  ): Promise<number> {
    const result = await this.api.sendVideo(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
      ...(replyParameters
        ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
        : {}),
    });
    return result.message_id;
  }

  async sendDocument(
    chatId: number | string,
    fileId: string,
    caption?: string,
    replyParameters?: ReplyParams
  ): Promise<number> {
    const result = await this.api.sendDocument(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
      ...(replyParameters
        ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
        : {}),
    });
    return result.message_id;
  }

  async sendAnimation(
    chatId: number | string,
    fileId: string,
    caption?: string,
    replyParameters?: ReplyParams
  ): Promise<number> {
    const result = await this.api.sendAnimation(chatId, fileId, {
      caption,
      parse_mode: 'HTML',
      ...(replyParameters
        ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
        : {}),
    });
    return result.message_id;
  }

  async sendText(
    chatId: number | string,
    text: string,
    replyParameters?: ReplyParams
  ): Promise<number> {
    const result = await this.api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      ...(replyParameters
        ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
        : {}),
    });
    return result.message_id;
  }

  async sendMediaGroup(
    chatId: number | string,
    mediaGroup: MediaGroupItem[],
    caption?: string,
    replyParameters?: ReplyParams
  ): Promise<number> {
    const ids = await this.sendMediaGroupAll(chatId, mediaGroup, caption, replyParameters);
    return ids[0];
  }

  /**
   * Send a media group and return ALL message IDs (one per album item).
   * Use this when you need to track every message for later cleanup.
   */
  async sendMediaGroupAll(
    chatId: number | string,
    mediaGroup: MediaGroupItem[],
    caption?: string,
    replyParameters?: ReplyParams
  ): Promise<number[]> {
    if (!mediaGroup || mediaGroup.length === 0) {
      throw new Error('Media group cannot be empty');
    }

    const media = mediaGroup.map((item: MediaGroupItem, index: number) => ({
      type: item.type,
      media: item.fileId,
      caption: index === 0 ? caption : undefined,
      parse_mode: index === 0 ? ('HTML' as const) : undefined,
    }));

    const result = await this.api.sendMediaGroup(chatId, media, {
      ...(replyParameters
        ? { reply_parameters: { message_id: replyParameters.messageId, chat_id: replyParameters.chatId } }
        : {}),
    });
    return result.map((m) => m.message_id);
  }
}
```

- [ ] **Step 7.2: Build check**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no TypeScript errors. If Grammy's `sendMediaGroup` doesn't accept options in the typed signature, check whether a raw call is needed for that specific method only.

- [ ] **Step 7.3: Commit**

```bash
git add src/core/sending/media-sender.service.ts
git commit -m "feat: add optional replyParameters to MediaSenderService send methods"
```

---

## Task 8: Thread `replyParameters` through `PostPublisherService`

**Files:**
- Modify: `src/core/posting/post-publisher.service.ts`

`PostPublisherService.publish` delegates to `mediaSender.sendMessage`. Pass `post.originalForward.replyParameters` as the third argument so cross-chat reply posts are published as replies in the target channel.

- [ ] **Step 8.1: Update `publish` to pass `replyParameters`**

In `src/core/posting/post-publisher.service.ts`, update the `publish` method:

```typescript
async publish(post: IScheduledPost): Promise<number> {
  if (post.action === 'forward') {
    return await this.copyMessage(post);
  }

  return await this.mediaSender.sendMessage(
    post.targetChannelId,
    post.content,
    post.originalForward.replyParameters
  );
}
```

- [ ] **Step 8.2: Build check**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 8.3: Run all tests**

```bash
cd /Users/eduard.a/coding/tg_poster_bot && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 8.4: Commit**

```bash
git add src/core/posting/post-publisher.service.ts
git commit -m "feat: pass replyParameters to MediaSenderService when publishing scheduled posts"
```

---

## Manual Verification Checklist

After all tasks complete, verify end-to-end in a live bot session:

- [ ] **Entity preservation**: Forward a message with bold/italic/link text, choose Transform. Confirm the preview and published post preserve formatting.
- [ ] **Blockquote entity**: Forward a message containing a Telegram blockquote. Confirm it renders as `<blockquote>` in the published post.
- [ ] **Cross-chat reply — basic**: In the bot chat, use Telegram's "reply in another chat" feature on a public channel post. Send the reply to the bot. Confirm the scheduling flow starts (channel select appears).
- [ ] **Cross-chat reply — attribution**: Complete the flow and confirm "via @channelname" attribution appears in the preview/post when the source channel is not red-listed.
- [ ] **Cross-chat reply — green list**: If the source channel is green-listed, confirm the bot does NOT auto-forward (normal transform flow proceeds).
- [ ] **Cross-chat reply — published as reply**: After scheduling, confirm the published post in the target channel appears as a reply to the original message.
- [ ] **Custom text unaffected**: Confirm replying to the bot's custom-text prompt still works normally (the `external_reply` guard doesn't break it).
