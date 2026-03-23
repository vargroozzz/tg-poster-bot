# Design: Cross-Chat Reply Support & Entity/HTML Preservation

**Date:** 2026-03-23

## Summary

Two related improvements to message handling:

1. **Entity/HTML preservation** — text formatting (bold, italic, links, blockquotes, etc.) is currently stripped during the transform flow because `extractMessageContent` returns raw strings instead of HTML. Fix by converting entities to HTML at the extraction point.

2. **Cross-chat reply (`external_reply`) support** — when the user sends a text message to the bot as a reply to a channel post from another chat (Telegram Bot API 7.0 `external_reply` field), the bot currently ignores the reply context and treats the message as plain non-forwarded text. The message should go through the regular transform flow with attribution derived from the reply origin, and should be published with `reply_parameters` so it appears as a reply to the original channel post in the target channel.

---

## Problem 1: Entity/HTML Preservation

### Root Cause

`extractMessageContent` in `forward.handler.ts` extracts `message.text` and `message.caption` as plain strings. Telegram entity metadata (`message.entities`, `message.caption_entities`) is discarded. All inline formatting is silently lost on the transform path.

The forward path is unaffected (uses `forwardMessage` API which preserves formatting natively).

### Fix

Call `entitiesToHtml(text, entities)` and `entitiesToHtml(caption, caption_entities)` inside `extractMessageContent` for every content type (text, photo, video, document, animation, media group caption).

This is a single call site fix that propagates to all downstream consumers: preview generation, scheduler, and post worker.

No other changes needed — all send paths already use `parse_mode: 'HTML'`.

---

## Problem 2: Cross-Chat Reply Support

### Context

In Telegram, a user can reply to a message in another chat (e.g. a channel post) while composing a message in a different chat. When the bot receives such a message, it has:

- `message.text` — the user's reply text (the content to post)
- `message.external_reply.origin` — origin info (channel or user), same shape as `forward_origin`
- `message.external_reply.chat` — the chat containing the original message
- `message.external_reply.message_id` — the original message ID

There is no `forward_origin` on such messages, so the current handler treats them as plain non-forwarded text and ignores the reply context entirely.

### Desired Behavior

1. The regular transform flow applies: auto-select transform (non-forwarded) → text handling → nickname selection → custom text → preview → schedule.
2. Attribution is derived from `external_reply.origin` exactly as it is from `forward_origin` (channel link, red/green list checks, nickname).
3. When published, the post uses `reply_parameters: { chat_id, message_id }` so it appears as a reply to the original message in the target channel.
4. Green-listed channel sources do **not** trigger auto-forward for external replies — the content is the user's own text, not the channel post itself.

### Data Flow

```
User sends text reply to channel post
  → bot receives Message { text, external_reply: { origin, chat, message_id } }
  → parseForwardInfo extracts channel info from external_reply.origin
  → sets replyParameters: { chatId: chat.id, messageId: message_id }
  → processSingleMessage: non-forwarded path (no forward_origin)
  → callback flow: auto-transform, text handling, nickname, custom text, preview
  → preview:schedule: ForwardInfo.replyParameters stored in ScheduledPost.originalForward
  → PostPublisherService: passes replyParameters to MediaSenderService
  → MediaSenderService: includes reply_parameters in Telegram API call
```

### Attribution Behavior

`external_reply.origin` is handled identically to `forward_origin`:
- `type === 'channel'` → extract `fromChannelId`, `fromChannelTitle`, `fromChannelUsername`, `messageLink`
- `type === 'user'` → extract `fromUserId`, `fromUsername`
- Other types → minimal info (no attribution fields)

Green/red list checks, nickname selection, and attribution string building all work unchanged because they consume `ForwardInfo` fields that are now populated from `external_reply.origin`.

### Auto-Forward Guard

`shouldAutoForward` currently returns `true` for green-listed channel sources. For external replies this would be wrong — the content to post is the user's own text, not the original channel post. The presence of `replyParameters` in `ForwardInfo` signals an external reply and causes `shouldAutoForward` to return `false`.

---

## Files Changed

| File | Change |
|------|--------|
| `src/types/message.types.ts` | Add `replyParameters?: { chatId: number; messageId: number }` to `ForwardInfo` |
| `src/utils/message-parser.ts` | Handle `message.external_reply`: extract origin info + reply params into `ForwardInfo` |
| `src/services/transformer.service.ts` | `shouldAutoForward`: return `false` when `forwardInfo.replyParameters` is set |
| `src/database/models/scheduled-post.model.ts` | Add `replyParameters: { chatId, messageId }` to `originalForward` sub-schema |
| `src/core/sending/media-sender.service.ts` | Accept optional `replyParameters`, pass as `reply_parameters` in all Telegram API send calls |
| `src/core/posting/post-publisher.service.ts` | Thread `post.originalForward.replyParameters` into `mediaSender.sendMessage` |
| `src/bot/handlers/forward.handler.ts` | `extractMessageContent`: use `entitiesToHtml` for `text`/`entities` and `caption`/`caption_entities` |

---

## Out of Scope

- Handling `external_reply` for media messages (photo, video etc.) sent as a cross-chat reply — the user described text replies as the primary case. Media handling follows naturally from the same changes but is not explicitly required.
- Previewing the reply context in the bot chat (the preview shows the post content; the "reply to" relationship only manifests in the target channel).
- Fallback behavior when the target channel cannot resolve the cross-chat reply (Telegram silently ignores `reply_parameters` if the message is inaccessible, so no special error handling is needed).
