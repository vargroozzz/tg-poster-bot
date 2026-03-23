# Design: Cross-Chat Reply Support & Entity/HTML Preservation

**Date:** 2026-03-23

## Summary

Two related improvements to message handling:

1. **Entity/HTML preservation** — text formatting (bold, italic, links, blockquotes, etc.) is currently stripped during the transform flow because `extractMessageContent` returns raw strings instead of HTML. Fix by converting entities to HTML at the extraction point, and add `blockquote` entity support to `entitiesToHtml`.

2. **Cross-chat reply (`external_reply`) support** — when the user sends a text message to the bot as a reply to a channel post from another chat (Telegram Bot API 7.0 `external_reply` field), the bot currently ignores the reply context and treats the message as plain non-forwarded text. The message should go through the regular transform flow with attribution derived from the reply origin, and should be published with `reply_parameters` so it appears as a reply to the original channel post in the target channel.

---

## Problem 1: Entity/HTML Preservation

### Root Cause

`extractMessageContent` in `forward.handler.ts` extracts `message.text` and `message.caption` as plain strings. Telegram entity metadata (`message.entities`, `message.caption_entities`) is discarded. All inline formatting is silently lost on the transform path.

The forward path is unaffected (uses `forwardMessage` API which preserves formatting natively).

### Fix

1. Call `entitiesToHtml(text, entities)` and `entitiesToHtml(caption, caption_entities)` inside `extractMessageContent` for every content type (text, photo, video, document, animation, media group caption). This is a single call site fix that propagates to all downstream consumers: preview generation, scheduler, and post worker. No other changes needed — all send paths already use `parse_mode: 'HTML'`.

2. Add `blockquote` entity handling to `entitiesToHtml` (Bot API 7.0, same release as `external_reply`). Open tag: `<blockquote>`, close tag: `</blockquote>`.

---

## Problem 2: Cross-Chat Reply Support

### Context

In Telegram, a user can reply to a message in another chat (e.g. a channel post) while composing a message in their private chat with the bot. When the bot receives such a message, it has:

- `message.text` — the user's reply text (the content to post)
- `message.external_reply.origin` — origin info (channel or user), same shape as `forward_origin`
- `message.external_reply.chat` — the chat containing the original message
- `message.external_reply.message_id` — the original message ID

Critically, `message.reply_to_message` is **not** set on cross-chat replies (there is no message in the current bot chat being replied to). This means the existing custom-text input filter (`bot.on('message:text').filter(ctx => !!ctx.message?.reply_to_message, ...)`) will not intercept these messages under normal conditions.

There is no `forward_origin` on such messages, so the current handler treats them as plain non-forwarded text and ignores the reply context entirely.

### Desired Behavior

1. The regular transform flow applies: auto-select transform (non-forwarded) → text handling → nickname selection → custom text → preview → schedule.
2. Attribution is derived from `external_reply.origin` exactly as it is from `forward_origin` (channel link, red/green list checks, nickname).
3. When published to the target channel, the post uses `reply_parameters: { chat_id, message_id }` so it appears as a reply to the original message.
4. Green-listed channel sources do **not** trigger auto-forward for external replies — the content is the user's own text, not the channel post itself.

### Handler Routing

External-reply messages have no `forward_origin`, so the existing branch at line 171 of `forward.handler.ts`:

```typescript
if (forwardOrigin && userId) { /* reply-chain buffering */ }
else { await processSingleMessage(ctx, message); }
```

already routes them correctly to `processSingleMessage` — **no change needed here**.

As a safety guard, the custom-text filter should explicitly reject messages that carry `external_reply`, even though `reply_to_message` is normally absent on them:

```typescript
bot.on('message:text').filter(
  (ctx) => !!ctx.message?.reply_to_message && !ctx.message?.external_reply,
  async (ctx, next) => { /* custom text handler */ }
);
```

This prevents an edge case where a user simultaneously replies to a bot message and references an external message.

### Data Flow

```
User sends text reply to channel post
  → bot receives Message { text, external_reply: { origin, chat, message_id } }
  → parseForwardInfo extracts channel info from external_reply.origin (fromChannelId, messageLink, etc.)
  → sets replyParameters: { chatId: chat.id, messageId: message_id }
  → processSingleMessage: non-forwarded path (no forward_origin)
  → callback flow: auto-transform, text handling, nickname, custom text, preview
  → preview:schedule: parseForwardInfo re-called from session.originalMessage
  → ForwardInfo.replyParameters populated → stored in ScheduledPost.originalForward.replyParameters
  → PostPublisherService: passes replyParameters to MediaSenderService.sendMessage
  → MediaSenderService: includes reply_parameters: { chat_id, message_id } in Telegram API call
```

### Session Model

`session.originalMessage` is stored as `Schema.Types.Mixed` (verbatim Grammy `Message` object). Since `external_reply` is part of the `Message`, it is stored automatically. **No session model changes are needed.**

### Attribution Behavior

`external_reply.origin` is handled identically to `forward_origin`:
- `type === 'channel'` → extract `fromChannelId`, `fromChannelTitle`, `fromChannelUsername`, `messageLink`
- `type === 'user'` → extract `fromUserId`, `fromUsername`
- Other types → minimal info (no attribution fields)

Green/red list checks, nickname selection, and attribution string building all work unchanged because they consume `ForwardInfo` fields now populated from `external_reply.origin`.

### Auto-Forward Guard

`shouldAutoForward` returns `false` for non-channel origins (no `fromChannelId`). The only unsafe case is an external reply whose `external_reply.origin.type === 'channel'` points to a green-listed channel — here `fromChannelId` is set and `isGreenListed` returns `true`, causing auto-forward to wrongly fire.

Fix: add an early return to `shouldAutoForward` before the green-list check:

```typescript
if (forwardInfo.replyParameters) return false; // external reply — never auto-forward
```

### replyParameters: Publisher vs. Preview

`replyParameters` must only be applied when publishing to the target channel, **not** during preview (which sends to the user's DM). The distinction is:

- `PreviewSenderService` calls `mediaSender.sendMessage(userId, content)` — no `replyParameters`
- `PostPublisherService` calls `mediaSender.sendMessage(post.targetChannelId, post.content)` — passes `post.originalForward.replyParameters`

Implementation: add an optional third parameter to `MediaSenderService.sendMessage(chatId, content, replyParameters?)`. `PostPublisherService` provides it; `PreviewSenderService` does not.

---

## Files Changed

| File | Change |
|------|--------|
| `src/utils/entities-to-html.ts` | Add `blockquote` entity: open `<blockquote>`, close `</blockquote>` |
| `src/bot/handlers/forward.handler.ts` | (1) `extractMessageContent`: use `entitiesToHtml` for `text`/`entities` and `caption`/`caption_entities`; (2) Custom-text filter: add `&& !ctx.message?.external_reply` guard |
| `src/types/message.types.ts` | Add `replyParameters?: { chatId: number; messageId: number }` to `ForwardInfo` |
| `src/utils/message-parser.ts` | Handle `message.external_reply`: extract origin info (same logic as `forward_origin`) + set `replyParameters` from `external_reply.chat.id` and `external_reply.message_id` |
| `src/services/transformer.service.ts` | `shouldAutoForward`: add early `if (forwardInfo.replyParameters) return false` before green-list check |
| `src/database/models/scheduled-post.model.ts` | Add to `originalForward` sub-schema: `replyParameters: { chatId: { type: Number }, messageId: { type: Number } }` |
| `src/core/sending/media-sender.service.ts` | Add optional `replyParameters?: { chatId: number; messageId: number }` param to `sendMessage` and individual send methods; pass as `reply_parameters: { message_id, chat_id }` in Telegram API calls |
| `src/core/posting/post-publisher.service.ts` | Pass `post.originalForward.replyParameters` as third argument to `mediaSender.sendMessage` |

---

## Out of Scope

- Media messages sent as cross-chat replies (photo, video, etc.) — user described text replies as the primary case. The same code changes would handle them automatically since `external_reply` can appear on any message type, but this is not explicitly tested.
- Previewing the reply context in the bot chat — the preview shows post content only; the "reply to" relationship manifests only in the target channel.
- Error handling when the target channel cannot resolve the cross-chat reply — Telegram silently ignores `reply_parameters` if the referenced message is inaccessible, so no special error handling is needed.
