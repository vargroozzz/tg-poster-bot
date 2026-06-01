# Callback Handler Refactor & Style Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 1,447-line `callback.handler.ts` god file into focused modules and fix all CLAUDE.md style violations introduced during recent feature work.

**Architecture:** Create `src/bot/handlers/callbacks/` with five files — `shared.ts` (helpers), `scheduling.ts`, `queue.ts`, `sleep.ts`, `interval.ts` — plus an `index.ts` barrel. Fold `queue-edit.handler.ts` into `queue.ts` to eliminate cross-module state coupling. Style fixes are applied to touched and adjacent files in a final cleanup task.

**Tech Stack:** TypeScript, Grammy (Telegram bot framework), MongoDB/Mongoose, Node.js

---

## File Map

| Action | Path |
|--------|------|
| Create | `src/bot/handlers/callbacks/shared.ts` |
| Create | `src/bot/handlers/callbacks/sleep.ts` |
| Create | `src/bot/handlers/callbacks/interval.ts` |
| Create | `src/bot/handlers/callbacks/scheduling.ts` |
| Create | `src/bot/handlers/callbacks/queue.ts` |
| Create | `src/bot/handlers/callbacks/index.ts` |
| Modify | `src/index.ts` — swap handler imports |
| Delete | `src/bot/handlers/callback.handler.ts` |
| Delete | `src/bot/handlers/queue-edit.handler.ts` |
| Modify | `src/bot/handlers/forward.handler.ts` — remove RC-DEBUG logs, fix dead code |
| Modify | `src/core/posting/post-publisher.service.ts` — remove RC-DEBUG log |
| Modify | `src/core/posting/post-scheduler.service.ts` — remove unnecessary transform call |
| Modify | `src/bot/handlers/command.handler.ts` — fix parallel arrays in /interval |
| Modify | `src/core/session/session.service.ts` — remove redundant JSDoc |

---

## Task 1: Create `callbacks/shared.ts` — shared helpers

**Files:**
- Create: `src/bot/handlers/callbacks/shared.ts`

This is the foundation. Every other callbacks module imports from here. Contains the four helpers currently duplicated across `callback.handler.ts` and `queue-edit.handler.ts`.

- [ ] **Step 1: Create the file**

```typescript
// src/bot/handlers/callbacks/shared.ts
import { Context } from 'grammy';
import { Message } from 'grammy/types';
import { DIContainer } from '../../../shared/di/container.js';
import type { SessionService } from '../../../core/session/session.service.js';
import { SessionState } from '../../../shared/constants/flow-states.js';
import { logger } from '../../../utils/logger.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { PreviewGeneratorService } from '../../../core/preview/preview-generator.service.js';
import { PreviewSenderService } from '../../../core/preview/preview-sender.service.js';
import { parseForwardInfo } from '../../../utils/message-parser.js';
import {
  findNicknameByUserId,
  getNicknameKeyboard,
} from '../../../shared/helpers/nickname.helper.js';
import { createCustomTextKeyboard } from '../keyboards/custom-text.keyboard.js';

let _sessionService: SessionService;

export function getSessionService(): SessionService | undefined {
  if (!_sessionService && DIContainer.has('SessionService')) {
    _sessionService = DIContainer.resolve<SessionService>('SessionService');
  }
  return _sessionService;
}

export async function deletePreviewMessages(
  ctx: Context,
  fromId: number,
  session: { previewMessageIds?: number[]; previewMessageId?: number }
): Promise<void> {
  const messageIds =
    (session.previewMessageIds?.length ?? 0) > 0
      ? (session.previewMessageIds ?? [])
      : session.previewMessageId
        ? [session.previewMessageId]
        : [];

  await Promise.all(
    messageIds.map((msgId) =>
      ctx.api
        .deleteMessage(fromId, msgId)
        .catch((err) => logger.warn(`Failed to delete preview message ${msgId}:`, err))
    )
  );
}

export async function showPreview(ctx: Context, sessionKey: string): Promise<void> {
  try {
    const fromId = ctx.from?.id;
    if (!fromId) return;

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

    const previewContent = await new PreviewGeneratorService().generatePreview(session);
    const previewMessageId = await new PreviewSenderService(ctx.api).sendPreview(
      fromId,
      previewContent,
      sessionKey
    );

    await sessionSvc.updateState(sessionKey, SessionState.PREVIEW, { previewMessageId });
    await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));

    logger.debug(`Preview shown for session ${sessionKey}`);
  } catch (error) {
    logger.error('Error showing preview:', error);
    await ctx.editMessageText('Preview generation failed. Please try again.');
  }
}

/**
 * Auto-selects a nickname if the message is from a known user; otherwise shows the
 * nickname selection keyboard. Returns true when auto-selected (caller need not show keyboard).
 */
export async function handleNicknameSelection(
  ctx: Context,
  originalMessage: Message,
  sessionId?: string,
  isPlainText?: boolean
): Promise<boolean> {
  const forwardInfo = parseForwardInfo(originalMessage);
  const fromUserId = forwardInfo?.fromUserId;

  if (fromUserId) {
    const nickname = await findNicknameByUserId(fromUserId);
    if (nickname) {
      logger.debug(`Auto-selecting nickname "${nickname}" for user ${fromUserId}`);
      const sessionSvc = getSessionService();
      if (sessionId && sessionSvc) {
        await sessionSvc.update(sessionId, { selectedUserId: fromUserId });
      }

      if (isPlainText && sessionId) {
        await showPreview(ctx, sessionId);
      } else {
        const keyboard = await createCustomTextKeyboard();
        await ctx.editMessageText('Do you want to add custom text to this post?', {
          reply_markup: keyboard,
        });
      }
      return true;
    }
  }

  const keyboard = await getNicknameKeyboard();
  await ctx.editMessageText('Who should be credited for this post?', {
    reply_markup: keyboard,
  });
  return false;
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run build
```

Expected: no errors on `callbacks/shared.ts`. Other files still compile fine since nothing imports this yet.

- [ ] **Step 3: Commit**

```bash
git add src/bot/handlers/callbacks/shared.ts
git commit -m "refactor: add callbacks/shared.ts with deduplicated helpers"
```

---

## Task 2: Create `callbacks/sleep.ts`

**Files:**
- Create: `src/bot/handlers/callbacks/sleep.ts`

Move the sleep window callbacks and their two private helpers (`showSleepStatus`, `saveSleepSettings`) out of `callback.handler.ts`. No logic changes.

- [ ] **Step 1: Create the file**

```typescript
// src/bot/handlers/callbacks/sleep.ts
import { Context } from 'grammy';
import { bot } from '../../bot.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { BotSettings } from '../../../database/models/bot-settings.model.js';
import { getSleepWindow } from '../../../utils/sleep-window.js';
import {
  createSleepStatusKeyboard,
  createHourPickerKeyboard,
  createSleepConfirmKeyboard,
} from '../keyboards/sleep.keyboard.js';

async function showSleepStatus(ctx: Context): Promise<void> {
  const sleepWindow = await getSleepWindow();
  const enabled = sleepWindow !== null;

  const text = enabled
    ? `Sleep hours: ${String(sleepWindow.startHour).padStart(2, '0')}:00 – ${String(sleepWindow.endHour).padStart(2, '0')}:00 ✅\nPosts scheduled during this window will be pushed to after ${String(sleepWindow.endHour).padStart(2, '0')}:00.`
    : 'Sleep hours: disabled';

  await ctx.editMessageText(text, { reply_markup: createSleepStatusKeyboard(enabled) });
}

async function saveSleepSettings(
  enabled: boolean,
  startHour?: number,
  endHour?: number
): Promise<void> {
  const baseOp = BotSettings.findOneAndUpdate(
    { key: 'sleep_enabled' },
    { key: 'sleep_enabled', value: String(enabled), updatedAt: new Date() },
    { upsert: true }
  );

  const ops =
    startHour !== undefined && endHour !== undefined
      ? [
          baseOp,
          BotSettings.findOneAndUpdate(
            { key: 'sleep_start' },
            { key: 'sleep_start', value: String(startHour), updatedAt: new Date() },
            { upsert: true }
          ),
          BotSettings.findOneAndUpdate(
            { key: 'sleep_end' },
            { key: 'sleep_end', value: String(endHour), updatedAt: new Date() },
            { upsert: true }
          ),
        ]
      : [baseOp];

  await Promise.all(ops);
}

bot.callbackQuery('sleep:enable', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText('Select start hour:', {
      reply_markup: createHourPickerKeyboard('start'),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error showing hour picker. Please try again.', 'sleep:enable callback');
  }
});

bot.callbackQuery('sleep:change', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText('Select start hour:', {
      reply_markup: createHourPickerKeyboard('start'),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error showing hour picker. Please try again.', 'sleep:change callback');
  }
});

bot.callbackQuery('sleep:disable', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    await saveSleepSettings(false);
    await showSleepStatus(ctx);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error disabling sleep hours. Please try again.', 'sleep:disable callback');
  }
});

bot.callbackQuery(/^sleep:start:(\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const startHour = parseInt((ctx.match as RegExpExecArray)[1], 10);
    await ctx.editMessageText('Select end hour:', {
      reply_markup: createHourPickerKeyboard('end', startHour),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error showing hour picker. Please try again.', 'sleep:start callback');
  }
});

bot.callbackQuery(/^sleep:end:(\d+):(\d+)$/, async (ctx: Context) => {
  try {
    const m = ctx.match as RegExpExecArray;
    const startHour = parseInt(m[1], 10);
    const endHour = parseInt(m[2], 10);

    if (endHour <= startHour) {
      await ctx.answerCallbackQuery({ text: 'End hour must be after start hour', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText(
      `Sleep hours: ${String(startHour).padStart(2, '0')}:00 – ${String(endHour).padStart(2, '0')}:00\n\nConfirm?`,
      { reply_markup: createSleepConfirmKeyboard(startHour, endHour) }
    );
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error showing confirmation. Please try again.', 'sleep:end callback');
  }
});

bot.callbackQuery(/^sleep:confirm:(\d+):(\d+)$/, async (ctx: Context) => {
  try {
    const m = ctx.match as RegExpExecArray;
    const startHour = parseInt(m[1], 10);
    const endHour = parseInt(m[2], 10);

    await ctx.answerCallbackQuery().catch(() => {});
    await saveSleepSettings(true, startHour, endHour);
    await showSleepStatus(ctx);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error saving sleep settings. Please try again.', 'sleep:confirm callback');
  }
});

bot.callbackQuery('sleep:cancel', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    await showSleepStatus(ctx);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error cancelling. Please try again.', 'sleep:cancel callback');
  }
});
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/bot/handlers/callbacks/sleep.ts
git commit -m "refactor: extract sleep callbacks into callbacks/sleep.ts"
```

---

## Task 3: Create `callbacks/interval.ts` — with parallel-array fix

**Files:**
- Create: `src/bot/handlers/callbacks/interval.ts`

Move the four interval callbacks. Apply the parallel-array fix: instead of `channels[]` + `intervals[]` indexed by `i`, zip into a single array of `{ ch, interval }` objects.

- [ ] **Step 1: Create the file**

```typescript
// src/bot/handlers/callbacks/interval.ts
import { Context } from 'grammy';
import { bot } from '../../bot.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { PostingChannel, getActivePostingChannels } from '../../../database/models/posting-channel.model.js';
import { getPostInterval, setChannelInterval, VALID_INTERVALS, type PostInterval } from '../../../utils/post-interval.js';
import {
  createChannelIntervalListKeyboard,
  createChannelIntervalPickerKeyboard,
} from '../keyboards/interval.keyboard.js';
import { QueueRepackService } from '../../../core/queue/queue-repack.service.js';

// interval:ch:<channelId> — show picker for a single channel
bot.callbackQuery(/^interval:ch:(-?\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const channelId = (ctx.match as RegExpExecArray)[1];
    const [channel, currentInterval] = await Promise.all([
      PostingChannel.findOne({ channelId }),
      getPostInterval(channelId),
    ]);
    const title = channel?.channelTitle ?? channelId;
    await ctx.editMessageText(
      `Post interval for ${title}: ${currentInterval} min\n\nSelect a new interval:`,
      { reply_markup: createChannelIntervalPickerKeyboard(channelId, currentInterval) }
    );
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error loading channel interval. Please try again.', 'interval:ch callback');
  }
});

// interval:set:<channelId>:<minutes> — save interval for a channel
bot.callbackQuery(/^interval:set:(-?\d+):(\d+)$/, async (ctx: Context) => {
  try {
    const m = ctx.match as RegExpExecArray;
    const channelId = m[1];
    const minutes = parseInt(m[2], 10);

    if (!VALID_INTERVALS.includes(minutes as PostInterval)) {
      await ctx.answerCallbackQuery('Invalid interval.');
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});
    await setChannelInterval(channelId, minutes as PostInterval);

    const channel = await PostingChannel.findOne({ channelId });
    const title = channel?.channelTitle ?? channelId;
    await ctx.editMessageText(
      `Post interval for ${title}: ${minutes} min ✅`,
      { reply_markup: createChannelIntervalPickerKeyboard(channelId, minutes as PostInterval) }
    );
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error saving interval. Please try again.', 'interval:set callback');
  }
});

// interval:repack:<channelId> — repack queue for a channel
bot.callbackQuery(/^interval:repack:(-?\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const channelId = (ctx.match as RegExpExecArray)[1];
    const repackService = new QueueRepackService();
    const [count, currentInterval, channel] = await Promise.all([
      repackService.repackChannel(channelId),
      getPostInterval(channelId),
      PostingChannel.findOne({ channelId }),
    ]);
    const title = channel?.channelTitle ?? channelId;
    const text =
      count === 0
        ? `No pending posts to reschedule for ${title}.`
        : `Queue repacked ✅\n${count} post${count === 1 ? '' : 's'} for ${title} rescheduled to ${currentInterval}-min intervals.`;
    await ctx.editMessageText(text, {
      reply_markup: createChannelIntervalPickerKeyboard(channelId, currentInterval),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error repacking queue. Please try again.', 'interval:repack callback');
  }
});

// interval:back — return to channel list
bot.callbackQuery('interval:back', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const channels = await getActivePostingChannels();

    const rows = await Promise.all(
      channels.map(async (ch) => ({ ch, interval: await getPostInterval(ch.channelId) }))
    );
    const lines = rows
      .map(({ ch, interval }) => `• ${ch.channelTitle ?? ch.channelId} — ${interval} min`)
      .join('\n');

    const text = channels.length === 0 ? 'No posting channels configured.' : `Post intervals:\n${lines}`;
    await ctx.editMessageText(text, { reply_markup: createChannelIntervalListKeyboard(channels) });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error loading intervals. Please try again.', 'interval:back callback');
  }
});
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/bot/handlers/callbacks/interval.ts
git commit -m "refactor: extract interval callbacks into callbacks/interval.ts"
```

---

## Task 4: Create `callbacks/scheduling.ts` — scheduling flow callbacks

**Files:**
- Create: `src/bot/handlers/callbacks/scheduling.ts`

Move all scheduling-flow callback handlers from `callback.handler.ts` (lines 186–1009): `select_channel`, `custom_text:*`, `select_nickname`, `text:*`, `action:quick/transform/forward`, `preview:schedule/cancel/back`. Swap local helper calls to import from `shared.ts`.

- [ ] **Step 1: Create the file**

```typescript
// src/bot/handlers/callbacks/scheduling.ts
import { Context } from 'grammy';
import { Message } from 'grammy/types';
import { bot } from '../../bot.js';
import { parseForwardInfo } from '../../../utils/message-parser.js';
import { transformerService } from '../../../services/transformer.service.js';
import { extractMessageContent } from '../forward.handler.js';
import { createForwardActionKeyboard } from '../keyboards/forward-action.keyboard.js';
import { createTextHandlingKeyboard } from '../keyboards/text-handling.keyboard.js';
import { createChannelSelectKeyboard } from '../keyboards/channel-select.keyboard.js';
import { CustomTextPreset } from '../../../database/models/custom-text-preset.model.js';
import { formatSlotTime } from '../../../utils/time-slots.js';
import { logger } from '../../../utils/logger.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { NICKNAME_NONE_KEY } from '../keyboards/nickname-select.keyboard.js';
import { findNicknameByUserId } from '../../../shared/helpers/nickname.helper.js';
import { PostSchedulerService } from '../../../core/posting/post-scheduler.service.js';
import { SessionState } from '../../../shared/constants/flow-states.js';
import { getNextState } from '../../../core/session/session-state-machine.js';
import { PostingChannel, getActivePostingChannels } from '../../../database/models/posting-channel.model.js';
import { ScheduledPostRepository } from '../../../database/repositories/scheduled-post.repository.js';
import { QueueService } from '../../../core/queue/queue.service.js';
import { createCustomTextKeyboard } from '../keyboards/custom-text.keyboard.js';
import { createEditChannelSelectKeyboard } from '../keyboards/edit-keyboards.js';
import {
  getSessionService,
  deletePreviewMessages,
  showPreview,
  handleNicknameSelection,
} from './shared.js';

const postScheduler = new PostSchedulerService();

async function getPendingForward(userId: number, messageId: number) {
  const sessionSvc = getSessionService();
  if (!sessionSvc) return undefined;
  try {
    const session = await sessionSvc.findByMessage(userId, messageId);
    if (session) logger.debug(`Found session in DB for message ${messageId}`);
    return session ?? undefined;
  } catch (error) {
    logger.error('Error fetching session from DB:', error);
    return undefined;
  }
}

// select_channel:<channelId>
bot.callbackQuery(/^select_channel:(.+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});

    const selectedChannelId = (ctx.match as RegExpExecArray)[1];
    if (!selectedChannelId) {
      await ctx.editMessageText('❌ Invalid channel selection.');
      return;
    }

    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;
    if (!originalMessage) {
      await ErrorMessages.originalMessageNotFound(ctx);
      return;
    }

    const forwardInfo = parseForwardInfo(originalMessage);
    const shouldAutoForward = await transformerService.shouldAutoForward(forwardInfo);
    const content = extractMessageContent(originalMessage);

    const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
    const foundKey = session?._id.toString();

    const sessionSvc = getSessionService();
    if (session && sessionSvc) {
      await sessionSvc.updateState(session._id.toString(), getNextState(SessionState.CHANNEL_SELECT, {
        isGreenListed: shouldAutoForward,
        isRedListed: false,
        hasText: false,
        isForward: false,
      }), { selectedChannel: selectedChannelId });
    }

    if (!foundKey) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    if (shouldAutoForward) {
      await sessionSvc?.update(session!._id.toString(), { selectedAction: 'forward' });
      await showPreview(ctx, foundKey);
      return;
    }

    if (content?.type === 'poll') {
      await sessionSvc?.update(session!._id.toString(), { selectedAction: 'forward' });
      await showPreview(ctx, session!._id.toString());
      logger.debug(`Poll message ${originalMessage.message_id}: auto-selected forward`);
      return;
    }

    const keyboard = createForwardActionKeyboard();
    await ctx.editMessageText(
      'Choose how to post this message:\n⚡ <b>Quick post</b> — transform, no attribution, no extra text',
      { reply_markup: keyboard, parse_mode: 'HTML' }
    );

    logger.debug(`Channel ${selectedChannelId} selected for message ${originalMessage.message_id}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error processing channel selection. Please try again.', 'Error in channel selection callback');
  }
});

// action:quick
bot.callbackQuery('action:quick', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});

    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;
    if (!originalMessage) {
      await ErrorMessages.originalMessageNotFound(ctx);
      return;
    }

    const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
    if (!session) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    const forwardInfo = parseForwardInfo(originalMessage);
    await getSessionService()?.updateState(session._id.toString(), SessionState.PREVIEW, {
      selectedAction: 'transform',
      textHandling: 'remove',
      selectedUserId: forwardInfo.fromUserId ?? null,
    });

    await showPreview(ctx, session._id.toString());
    logger.debug(`Quick post selected for message ${originalMessage.message_id}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error processing quick post. Please try again.', 'Error in quick post callback');
  }
});

// action:transform
bot.callbackQuery('action:transform', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});

    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;
    if (!originalMessage) {
      await ErrorMessages.originalMessageNotFound(ctx);
      return;
    }

    const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
    const content = extractMessageContent(originalMessage);
    const hasText = !!(content?.text && content.text.trim().length > 0);

    if (session) {
      await getSessionService()?.updateState(
        session._id.toString(),
        getNextState(SessionState.ACTION_SELECT, { isGreenListed: false, isRedListed: false, hasText, isForward: false }),
        { selectedAction: 'transform' }
      );
    }

    if (hasText) {
      await ctx.editMessageText('How should the text be handled?', {
        reply_markup: createTextHandlingKeyboard(),
      });
    } else {
      await handleNicknameSelection(ctx, originalMessage, session?._id.toString());
    }

    logger.debug(`Transform action selected for message ${originalMessage.message_id}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error processing transform. Please try again.', 'Error in transform callback');
  }
});

// action:forward
bot.callbackQuery('action:forward', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});

    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;
    if (!originalMessage) {
      await ErrorMessages.originalMessageNotFound(ctx);
      return;
    }

    const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
    const foundKey = session?._id.toString();
    const { selectedChannel } = session ?? {};

    if (!foundKey) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    if (!selectedChannel) {
      await ErrorMessages.channelSelectionRequired(ctx);
      return;
    }

    await getSessionService()?.update(foundKey, { selectedAction: 'forward' });
    await showPreview(ctx, foundKey);

    logger.debug(`Forward action selected for message ${originalMessage.message_id}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error scheduling post. Please try again.', 'Error in forward callback');
  }
});

// text:(keep|remove|quote)
bot.callbackQuery(/^text:(keep|remove|quote)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});

    const textHandling = (ctx.match as RegExpExecArray)[1] as 'keep' | 'remove' | 'quote';
    if (!textHandling) {
      await ErrorMessages.invalidSelection(ctx, 'text handling option');
      return;
    }

    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;
    if (!originalMessage) {
      await ErrorMessages.originalMessageNotFound(ctx);
      return;
    }

    const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
    const foundKey = session?._id.toString();
    if (!foundKey) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    await getSessionService()?.updateState(
      foundKey,
      getNextState(SessionState.TEXT_HANDLING, { isGreenListed: false, isRedListed: false, hasText: true, isForward: false }),
      { textHandling }
    );

    await handleNicknameSelection(ctx, originalMessage, foundKey);
    logger.debug(`Text handling "${textHandling}" selected for message ${originalMessage.message_id}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error processing text handling. Please try again.', 'Error in text handling callback');
  }
});

// select_nickname:<userId|none>
bot.callbackQuery(/^select_nickname:(.+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});

    const nicknameSelection = (ctx.match as RegExpExecArray)[1];
    if (!nicknameSelection) {
      await ErrorMessages.invalidSelection(ctx, 'nickname');
      return;
    }

    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;
    if (!originalMessage) {
      await ErrorMessages.originalMessageNotFound(ctx);
      return;
    }

    const selectedUserId = nicknameSelection === NICKNAME_NONE_KEY ? null : parseInt(nicknameSelection, 10);

    const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
    const foundKey = session?._id.toString();
    if (!foundKey) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    const fullMessage = session?.originalMessage ?? originalMessage;
    const isPlainText =
      fullMessage.text !== undefined &&
      !('photo' in fullMessage && fullMessage.photo) &&
      !('video' in fullMessage && fullMessage.video) &&
      !('document' in fullMessage && fullMessage.document) &&
      !('animation' in fullMessage && fullMessage.animation) &&
      !('external_reply' in fullMessage && fullMessage.external_reply) &&
      !fullMessage.forward_origin;

    const nextState = getNextState(SessionState.NICKNAME_SELECT, {
      isGreenListed: false, isRedListed: false, hasText: false, isForward: false, isPlainText,
    });
    await getSessionService()?.updateState(foundKey, nextState, { selectedUserId });

    if (nextState === SessionState.PREVIEW) {
      await showPreview(ctx, foundKey);
    } else {
      const keyboard = await createCustomTextKeyboard();
      await ctx.editMessageText('Do you want to add custom text to this post?', {
        reply_markup: keyboard,
      });
    }

    logger.debug(`Nickname "${nicknameSelection}" selected for message ${originalMessage.message_id}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error processing nickname selection. Please try again.', 'Error in nickname selection callback');
  }
});

// custom_text:(add|skip)
bot.callbackQuery(/^custom_text:(add|skip)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});

    const action = (ctx.match as RegExpExecArray)[1];
    if (!action) {
      await ErrorMessages.invalidSelection(ctx, 'action');
      return;
    }

    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;
    if (!originalMessage) {
      await ErrorMessages.originalMessageNotFound(ctx);
      return;
    }

    const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
    const foundKey = session?._id.toString();
    if (!foundKey) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    const updates = action === 'add' ? { waitingForCustomText: true } : { customText: undefined };
    const nextState = action === 'add' ? SessionState.CUSTOM_TEXT : SessionState.PREVIEW;
    await getSessionService()?.updateState(foundKey, nextState, updates);

    if (action === 'add') {
      await ctx.editMessageText(
        '✍️ Reply to this message with your custom text.\n\nThis text will be added at the beginning of your post.'
      );
    } else {
      await showPreview(ctx, foundKey);
    }

    logger.debug(`Custom text action "${action}" for message ${originalMessage.message_id}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error processing custom text. Please try again.', 'Error in custom text callback');
  }
});

// custom_text:preset:<presetId>
bot.callbackQuery(/^custom_text:preset:(.+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});

    const presetId = (ctx.match as RegExpExecArray)[1];
    if (!presetId) {
      await ErrorMessages.invalidSelection(ctx, 'preset');
      return;
    }

    const preset = await CustomTextPreset.findById(presetId).lean();
    if (!preset) {
      await ctx.editMessageText('❌ Preset not found. It may have been deleted.');
      return;
    }

    const originalMessage = ctx.callbackQuery?.message?.reply_to_message;
    if (!originalMessage) {
      await ErrorMessages.originalMessageNotFound(ctx);
      return;
    }

    const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
    const foundKey = session?._id.toString();
    if (!foundKey) {
      await ErrorMessages.sessionExpired(ctx);
      return;
    }

    await getSessionService()?.updateState(foundKey, SessionState.PREVIEW, { customText: preset.text });
    await showPreview(ctx, foundKey);

    logger.debug(`Preset custom text "${preset.label}" selected for message ${originalMessage.message_id}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error selecting preset text. Please try again.', 'Error in custom text preset callback');
  }
});

// preview:schedule:<sessionKey>
bot.callbackQuery(/^preview:schedule:(.+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});

    const sessionKey = (ctx.match as RegExpExecArray)[1];
    if (!sessionKey) {
      await ctx.reply('Invalid session. Please try again.');
      return;
    }

    const sessionSvc = getSessionService();
    if (!sessionSvc) {
      await ctx.reply('Service unavailable. Please try again.');
      return;
    }

    const session = await sessionSvc.findById(sessionKey);
    if (!session) {
      await ctx.reply('Session expired. Please forward the message again.');
      return;
    }

    const fromId = ctx.from?.id;

    // Edit-session confirm path
    if (session.editingPostId) {
      const {
        editingPostId,
        editingOriginalChannelId,
        editingOriginalScheduledTime,
        editingRawContent,
        editingOriginalForward,
      } = session;

      const repository = new ScheduledPostRepository();
      const sameChannel = session.selectedChannel === editingOriginalChannelId;

      if (sameChannel) {
        let newContent = editingRawContent!;
        if (session.selectedAction === 'transform') {
          const selectedNickname = session.selectedUserId
            ? await findNicknameByUserId(session.selectedUserId)
            : null;
          const transformedText = await transformerService.transformMessage(
            editingRawContent!.text ?? '',
            editingOriginalForward!,
            'transform',
            session.textHandling ?? 'keep',
            selectedNickname,
            session.customText
          );
          newContent = { ...editingRawContent!, text: transformedText };
        }

        const updated = await repository.updatePost(editingPostId!, {
          content: newContent,
          action: session.selectedAction ?? 'transform',
          rawContent: editingRawContent!,
          textHandling: session.textHandling,
          selectedUserId: session.selectedUserId,
          customText: session.customText,
        });

        if (fromId) await deletePreviewMessages(ctx, fromId, session);
        await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
        await sessionSvc.complete(sessionKey);

        if (!updated) {
          await ctx.reply('⚠️ Post was already published — your changes were not applied.');
          return;
        }

        const channelDoc = await PostingChannel.findOne({ channelId: editingOriginalChannelId }).lean();
        const channelLabel = channelDoc?.channelTitle ?? channelDoc?.channelUsername ?? editingOriginalChannelId;
        await ctx.reply(
          `✅ Post updated!\nTarget: ${channelLabel}\nScheduled for: ${formatSlotTime(editingOriginalScheduledTime!)}`
        );
      } else {
        await new QueueService().deleteAndCascade(editingPostId!);

        const newChannelId = session.selectedChannel!;
        const { scheduledTime } =
          session.selectedAction === 'forward'
            ? await postScheduler.scheduleForwardPost({ targetChannelId: newChannelId, forwardInfo: editingOriginalForward!, content: editingRawContent! })
            : await postScheduler.scheduleTransformPost({ targetChannelId: newChannelId, forwardInfo: editingOriginalForward!, content: editingRawContent!, textHandling: session.textHandling ?? 'keep', selectedUserId: session.selectedUserId, customText: session.customText });

        if (fromId) await deletePreviewMessages(ctx, fromId, session);
        await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
        await sessionSvc.complete(sessionKey);

        const channelDoc = await PostingChannel.findOne({ channelId: newChannelId }).lean();
        const channelLabel = channelDoc?.channelTitle ?? channelDoc?.channelUsername ?? newChannelId;
        await ctx.reply(`✅ Moved to ${channelLabel}\nScheduled for: ${formatSlotTime(scheduledTime)}`);
      }

      logger.info(`Edit confirmed for session ${sessionKey}`);
      return;
    }

    // Normal schedule path
    const originalMessage = session.originalMessage!;
    const mediaGroupMessages = session.mediaGroupMessages;
    const selectedChannel = session.selectedChannel;

    if (!selectedChannel) {
      await ctx.reply('No channel selected.');
      return;
    }

    const forwardInfo = parseForwardInfo(originalMessage);
    if (mediaGroupMessages && mediaGroupMessages.length > 1) {
      forwardInfo.mediaGroupMessageIds = mediaGroupMessages.map((msg) => msg.message_id);
    }

    const replyChain = session.replyChainMessages;
    if (replyChain && replyChain.length > 1) {
      forwardInfo.replyChainMessageIds = replyChain.map((msg) => msg.message_id);
    }

    const content = extractMessageContent(originalMessage, mediaGroupMessages);
    if (!content) {
      await ctx.reply('Unsupported message type.');
      return;
    }

    const { textHandling = 'keep', selectedUserId, customText } = session;
    const baseParams = { targetChannelId: selectedChannel, originalMessage, forwardInfo, content };

    const { scheduledTime } =
      session.selectedAction === 'forward'
        ? await postScheduler.scheduleForwardPost(baseParams)
        : await postScheduler.scheduleTransformPost({ ...baseParams, textHandling, selectedUserId, customText });

    if (fromId) await deletePreviewMessages(ctx, fromId, session);
    await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
    await sessionSvc.complete(sessionKey);

    const channelDoc = await PostingChannel.findOne({ channelId: selectedChannel }).lean();
    const channelLabel = channelDoc?.channelTitle ?? channelDoc?.channelUsername ?? selectedChannel;
    await ctx.reply(`Post scheduled!\nTarget: ${channelLabel}\nScheduled for: ${formatSlotTime(scheduledTime)}`);

    logger.info(`Post scheduled from preview for session ${sessionKey}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Failed to schedule post. Please try again.', 'Error in preview:schedule callback');
  }
});

// preview:cancel:<sessionKey>
bot.callbackQuery(/^preview:cancel:(.+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});

    const sessionKey = (ctx.match as RegExpExecArray)[1];
    if (!sessionKey) {
      await ctx.reply('Invalid session.');
      return;
    }

    const sessionSvc = getSessionService();
    if (!sessionSvc) {
      await ctx.reply('Service unavailable.');
      return;
    }

    const session = await sessionSvc.findById(sessionKey);
    if (!session) {
      await ctx.reply('Session already expired or cancelled.');
      return;
    }

    const fromId = ctx.from?.id;
    if (fromId) await deletePreviewMessages(ctx, fromId, session);

    await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));

    if (session.editingPostId) {
      await sessionSvc.complete(sessionKey);
      await ctx.reply('Edit cancelled.');
      logger.info(`Edit cancelled for session ${sessionKey}`);
      return;
    }

    await sessionSvc.complete(sessionKey);
    await ctx.reply('Cancelled. Forward a new message to start over.');
    logger.info(`Preview cancelled for session ${sessionKey}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error cancelling preview.', 'Error in preview:cancel callback');
  }
});

// preview:back:<sessionKey>
bot.callbackQuery(/^preview:back:(.+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});

    const sessionKey = (ctx.match as RegExpExecArray)[1];
    if (!sessionKey) {
      await ctx.reply('Invalid session.');
      return;
    }

    const sessionSvc = getSessionService();
    if (!sessionSvc) {
      await ctx.reply('Service unavailable.');
      return;
    }

    const session = await sessionSvc.findById(sessionKey);
    if (!session) {
      await ctx.reply('Session already expired or cancelled.');
      return;
    }

    const fromId = ctx.from?.id;
    if (fromId) await deletePreviewMessages(ctx, fromId, session);
    await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));

    if (session.editingPostId) {
      await sessionSvc.updateState(sessionKey, SessionState.CHANNEL_SELECT, {
        selectedChannel: session.editingOriginalChannelId,
        selectedAction: undefined,
        textHandling: undefined,
        selectedUserId: undefined,
        customText: undefined,
        previewMessageId: undefined,
        previewMessageIds: undefined,
      });

      const channels = await getActivePostingChannels();
      if (channels.length === 0) {
        await ctx.reply('⚠️ No posting channels configured.');
        return;
      }
      if (!fromId) return;
      const keyboard = createEditChannelSelectKeyboard(channels, sessionKey);
      await ctx.api.sendMessage(fromId, '📍 Select target channel:', { reply_markup: keyboard as any });
      logger.info(`Edit back: re-showing channel select for session ${sessionKey}`);
      return;
    }

    await sessionSvc.updateState(sessionKey, SessionState.CHANNEL_SELECT, {
      selectedChannel: undefined,
      selectedAction: undefined,
      selectedUserId: undefined,
      textHandling: undefined,
      customText: undefined,
      previewMessageId: undefined,
      previewMessageIds: undefined,
    });

    const postingChannels = await getActivePostingChannels();
    if (postingChannels.length === 0) {
      await ctx.reply('⚠️ No posting channels configured.');
      return;
    }

    const channelItems = postingChannels.map((ch) => ({
      id: ch.channelId,
      title: ch.channelTitle ?? ch.channelId,
      username: ch.channelUsername,
    }));

    await ctx.api.sendMessage(session.originalMessage!.chat.id, '📍 Select target channel:', {
      reply_markup: createChannelSelectKeyboard(channelItems),
      reply_to_message_id: session.originalMessage!.message_id,
    });

    logger.info(`Preview back for session ${sessionKey}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error going back.', 'Error in preview:back callback');
  }
});
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/bot/handlers/callbacks/scheduling.ts
git commit -m "refactor: extract scheduling flow callbacks into callbacks/scheduling.ts"
```

---

## Task 5: Create `callbacks/queue.ts` — queue + edit callbacks

**Files:**
- Create: `src/bot/handlers/callbacks/queue.ts`

Combine queue callbacks (from `callback.handler.ts` lines 1010–1153) with all of `queue-edit.handler.ts`. The `queuePreviewStateMap` becomes a file-local `const` — no more cross-module export. The `renderQueuePage` helper moves here too. `showEditNicknameStep` stays here (edit-flow specific logic, not worth unifying with shared `handleNicknameSelection`).

- [ ] **Step 1: Create the file**

```typescript
// src/bot/handlers/callbacks/queue.ts
import { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { bot } from '../../bot.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { logger } from '../../../utils/logger.js';
import { SessionState } from '../../../shared/constants/flow-states.js';
import { DIContainer } from '../../../shared/di/container.js';
import type { SessionService } from '../../../core/session/session.service.js';
import { ScheduledPostRepository } from '../../../database/repositories/scheduled-post.repository.js';
import { PostingChannel, getActivePostingChannels } from '../../../database/models/posting-channel.model.js';
import { QueueService } from '../../../core/queue/queue.service.js';
import { QueuePreviewSenderService } from '../../../core/queue/queue-preview-sender.service.js';
import { PreviewGeneratorService } from '../../../core/preview/preview-generator.service.js';
import { PreviewSenderService } from '../../../core/preview/preview-sender.service.js';
import { transformerService } from '../../../services/transformer.service.js';
import { CustomTextPreset } from '../../../database/models/custom-text-preset.model.js';
import { findNicknameByUserId, getNicknameOptions } from '../../../shared/helpers/nickname.helper.js';
import { NICKNAME_NONE_KEY } from '../keyboards/nickname-select.keyboard.js';
import { createQueueChannelSelectKeyboard } from '../keyboards/queue-channel-select.keyboard.js';
import { createQueueListKeyboard } from '../keyboards/queue-list.keyboard.js';
import {
  createEditChannelSelectKeyboard,
  createEditForwardActionKeyboard,
  createEditTextHandlingKeyboard,
  createEditNicknameKeyboard,
  createEditCustomTextKeyboard,
} from '../keyboards/edit-keyboards.js';
import { formatSlotTime } from '../../../utils/time-slots.js';
import { getSessionService } from './shared.js';

const queueService = new QueueService();

interface QueuePreviewState {
  previewMessageIds: number[];
  queueMessageId: number;
  channelId: string;
  page: number;
}

const queuePreviewStateMap = new Map<number, QueuePreviewState>();

async function renderQueuePage(
  ctx: Context,
  channelId: string,
  page: number,
  messageId?: number
): Promise<void> {
  const channels = await getActivePostingChannels();
  const channel = channels.find((ch) => ch.channelId === channelId);
  const channelTitle = channel?.channelTitle ?? channelId;

  const { posts, labels, totalCount, totalPages } = await queueService.getChannelQueuePage(channelId, page);

  const clampedPage = Math.min(page, totalPages);
  if (clampedPage !== page) {
    return renderQueuePage(ctx, channelId, clampedPage, messageId);
  }

  const header = `📋 ${channelTitle} — Queue (${totalCount} post${totalCount !== 1 ? 's' : ''})`;

  if (posts.length === 0) {
    const text = `${header}\n\nNo pending posts.`;
    const keyboard = new InlineKeyboard().text('← Channels', 'queue:channels');
    if (messageId) {
      await ctx.api.editMessageText(ctx.chat!.id, messageId, text, { reply_markup: keyboard });
    } else {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    }
    return;
  }

  const postLines = posts
    .map((post, i) => `${(clampedPage - 1) * 5 + i + 1}. ${formatSlotTime(post.scheduledTime)} — ${labels[i]}`)
    .join('\n');

  const text = `${header}\n\n${postLines}`;
  const keyboard = createQueueListKeyboard({
    postIds: posts.map((p) => p._id.toString()),
    channelId,
    page: clampedPage,
    totalPages,
  });

  if (messageId) {
    await ctx.api.editMessageText(ctx.chat!.id, messageId, text, { reply_markup: keyboard });
  } else {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  }
}

// ── Queue browsing ────────────────────────────────────────────────────────────

bot.callbackQuery('queue:noop', async (ctx: Context) => {
  await ctx.answerCallbackQuery().catch(() => {});
});

bot.callbackQuery('queue:channels', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const channels = await getActivePostingChannels();
    if (channels.length === 0) {
      await ctx.editMessageText('⚠️ No posting channels configured. Use /addchannel first.');
      return;
    }
    const keyboard = createQueueChannelSelectKeyboard(channels);
    await ctx.editMessageText('📋 Select a channel to view its queue:', { reply_markup: keyboard });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error loading channels.', 'queue:channels');
  }
});

bot.callbackQuery(/^queue:ch:(.+):(\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const m = ctx.match as RegExpExecArray;
    await renderQueuePage(ctx, m[1], parseInt(m[2], 10));
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error loading queue.', 'queue:ch callback');
  }
});

bot.callbackQuery(/^queue:preview:([^:]+):(.+):(\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const m = ctx.match as RegExpExecArray;
    const postId = m[1];
    const channelId = m[2];
    const page = parseInt(m[3], 10);
    const userId = ctx.from?.id;
    const queueMessageId = ctx.callbackQuery?.message?.message_id;

    if (!userId || !queueMessageId) return;

    const post = await new ScheduledPostRepository().findById(postId);
    if (!post) {
      await ctx.reply('❌ Post not found — it may have already been published or deleted.');
      return;
    }

    const { previewMessageIds } = await new QueuePreviewSenderService(ctx.api).sendPreview(userId, post);
    queuePreviewStateMap.set(userId, { previewMessageIds, queueMessageId, channelId, page });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error generating preview.', 'queue:preview callback');
  }
});

bot.callbackQuery(/^queue:del:(.+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const postId = (ctx.match as RegExpExecArray)[1];
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = queuePreviewStateMap.get(userId);
    if (!state) {
      await ctx.reply('❌ Preview state expired. Please use /queue again.');
      return;
    }

    const { previewMessageIds, queueMessageId, channelId, page } = state;
    queuePreviewStateMap.delete(userId);

    const result = await queueService.deleteAndCascade(postId);

    await Promise.all(
      previewMessageIds.map((msgId) =>
        ctx.api.deleteMessage(userId, msgId).catch((err) =>
          logger.warn(`Failed to delete preview message ${msgId}:`, err)
        )
      )
    );
    await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));

    if (!result) {
      await ctx.reply('❌ Post not found — it may have already been published or deleted.');
    }

    await renderQueuePage(ctx, channelId, page, queueMessageId);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error deleting post.', 'queue:del callback');
  }
});

bot.callbackQuery('queue:back', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = queuePreviewStateMap.get(userId);
    if (!state) {
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    const { previewMessageIds } = state;
    queuePreviewStateMap.delete(userId);

    await Promise.all(
      previewMessageIds.map((msgId) =>
        ctx.api.deleteMessage(userId, msgId).catch((err) =>
          logger.warn(`Failed to delete preview message ${msgId}:`, err)
        )
      )
    );
    await ctx.deleteMessage().catch((err) => logger.warn('Failed to delete control message:', err));
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error going back.', 'queue:back callback');
  }
});

// ── Edit flow entry ───────────────────────────────────────────────────────────

bot.callbackQuery(/^queue:edit:([a-f0-9]{24})$/, async (ctx: Context) => {
  try {
    const postId = (ctx.match as RegExpExecArray)[1];
    const userId = ctx.from?.id;
    if (!userId) return;

    const post = await new ScheduledPostRepository().findById(postId);
    if (!post) {
      await ctx.answerCallbackQuery({ text: '❌ Post already published or deleted', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});

    const state = queuePreviewStateMap.get(userId);
    if (state) {
      await Promise.all(
        state.previewMessageIds.map((msgId) => ctx.api.deleteMessage(userId, msgId).catch(() => {}))
      );
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
    await ctx.api.sendMessage(userId, '📍 Select target channel:', { reply_markup: keyboard as any });

    logger.debug(`Edit session ${sessionId} started for user ${userId}, post ${postId}`);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error starting edit.', 'queue:edit entry');
  }
});

// ── Edit: channel selection ───────────────────────────────────────────────────

bot.callbackQuery(/^queue:edit:ch:([^:]+):(-?\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const [, sessionId, channelId] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    const isGreenListed = session.editingOriginalForward
      ? await transformerService.shouldAutoForward(session.editingOriginalForward)
      : false;
    const isRedListed = session.editingOriginalForward?.fromChannelId
      ? await transformerService.isRedListed(String(session.editingOriginalForward.fromChannelId))
      : false;
    const rawContent = session.editingRawContent!;
    const hasText = !!(rawContent.text && rawContent.text.trim().length > 0);
    const isPoll = rawContent.type === 'poll';

    await sessionSvc!.updateState(sessionId, SessionState.CHANNEL_SELECT, { selectedChannel: channelId });

    if (isPoll || isGreenListed) {
      await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, { selectedAction: 'forward' });
      await showEditPreview(ctx, sessionId);
      return;
    }

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

    await ctx.editMessageText(
      'Choose how to post this message:\n⚡ <b>Quick post</b> — transform, no attribution, no extra text',
      { reply_markup: createEditForwardActionKeyboard(sessionId) as any, parse_mode: 'HTML' }
    );
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting channel.', 'queue:edit:ch');
  }
});

// ── Edit: action selection ────────────────────────────────────────────────────

bot.callbackQuery(/^queue:edit:action:([^:]+):(transform|forward|quick)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const [, sessionId, action] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    const hasText = !!(session.editingRawContent?.text && session.editingRawContent.text.trim().length > 0);

    if (action === 'quick') {
      await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, {
        selectedAction: 'transform',
        textHandling: 'remove',
        selectedUserId: session.editingOriginalForward?.fromUserId ?? null,
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

// ── Edit: text handling ───────────────────────────────────────────────────────

bot.callbackQuery(/^queue:edit:text:([^:]+):(keep|remove|quote)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const [, sessionId, textHandling] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    await sessionSvc!.update(sessionId, { textHandling: textHandling as 'keep' | 'remove' | 'quote' });
    await showEditNicknameStep(ctx, sessionId);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting text handling.', 'queue:edit:text');
  }
});

// ── Edit: nickname selection ──────────────────────────────────────────────────

bot.callbackQuery(/^queue:edit:nickname:([^:]+):([^:]+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const [, sessionId, nicknameKey] = ctx.match as RegExpExecArray;

    const sessionSvc = getSessionService();
    const session = await sessionSvc?.findById(sessionId);
    if (!session) {
      await ctx.reply('❌ Edit session expired. Use /queue to start again.');
      return;
    }

    const parsedUserId = parseInt(nicknameKey, 10);
    const selectedUserId = nicknameKey === NICKNAME_NONE_KEY || isNaN(parsedUserId) ? null : parsedUserId;

    await sessionSvc!.update(sessionId, { selectedUserId });
    const keyboard = await createEditCustomTextKeyboard(sessionId);
    await ctx.editMessageText('Do you want to add custom text to this post?', {
      reply_markup: keyboard as any,
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting nickname.', 'queue:edit:nickname');
  }
});

// ── Edit: custom text ─────────────────────────────────────────────────────────

bot.callbackQuery(/^queue:edit:custom:([^:]+):(add|skip)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
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
      await sessionSvc!.updateState(sessionId, SessionState.CUSTOM_TEXT, { waitingForCustomText: true });
      await ctx.editMessageText(
        '✍️ Reply to this message with your custom text.\n\nThis text will be added at the beginning of your post.'
      );
    }
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error with custom text.', 'queue:edit:custom');
  }
});

// ec:preset:<sessionId>:<presetId>
bot.callbackQuery(/^ec:preset:([^:]+):(.+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
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
    await ErrorMessages.catchAndReply(ctx, error, '❌ Error selecting preset.', 'ec:preset');
  }
});

// ── Edit helpers ──────────────────────────────────────────────────────────────

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
    const previewContent = await new PreviewGeneratorService().generatePreview(session);
    await new PreviewSenderService(ctx.api).sendPreview(userId, previewContent, sessionId);
    await ctx.deleteMessage().catch(() => {});
    await sessionSvc!.updateState(sessionId, SessionState.PREVIEW, {});
    logger.debug(`Edit preview shown for session ${sessionId}`);
  } catch (error) {
    logger.error('Error showing edit preview:', error);
    await ctx.editMessageText('❌ Preview generation failed. Please try again.');
  }
}

async function showEditNicknameStep(ctx: Context, sessionId: string): Promise<void> {
  const sessionSvc = getSessionService();
  const session = await sessionSvc?.findById(sessionId);
  if (!session) return;

  const fromUserId = session.editingOriginalForward?.fromUserId;
  if (fromUserId) {
    const autoNickname = await findNicknameByUserId(fromUserId);
    if (autoNickname) {
      await sessionSvc!.update(sessionId, { selectedUserId: fromUserId });
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

- [ ] **Step 2: Verify it compiles**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/bot/handlers/callbacks/queue.ts
git commit -m "refactor: extract queue + edit callbacks into callbacks/queue.ts"
```

---

## Task 6: Wire up `callbacks/index.ts`, update `src/index.ts`, delete old files

**Files:**
- Create: `src/bot/handlers/callbacks/index.ts`
- Modify: `src/index.ts`
- Delete: `src/bot/handlers/callback.handler.ts`
- Delete: `src/bot/handlers/queue-edit.handler.ts`

- [ ] **Step 1: Create `callbacks/index.ts`**

```typescript
// src/bot/handlers/callbacks/index.ts
// Imports each module to register its bot.callbackQuery handlers.
import './scheduling.js';
import './queue.js';
import './sleep.js';
import './interval.js';
```

- [ ] **Step 2: Update `src/index.ts` — swap the two old imports for the new barrel**

In `src/index.ts`, find:
```typescript
import './bot/handlers/callback.handler.js';
import './bot/handlers/queue-edit.handler.js';
```

Replace with:
```typescript
import './bot/handlers/callbacks/index.js';
```

- [ ] **Step 3: Verify it compiles and all callbacks still register**

```bash
npm run build
```

Expected: clean build with no "cannot find module" errors.

- [ ] **Step 4: Delete the old files**

```bash
rm src/bot/handlers/callback.handler.ts
rm src/bot/handlers/queue-edit.handler.ts
```

- [ ] **Step 5: Verify the build is still clean after deletion**

```bash
npm run build
```

Expected: clean build — nothing should import the deleted files.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: wire callbacks/index.ts, remove callback.handler.ts and queue-edit.handler.ts"
```

---

## Task 7: Style fixes in remaining files

**Files:**
- Modify: `src/bot/handlers/forward.handler.ts`
- Modify: `src/core/posting/post-publisher.service.ts`
- Modify: `src/core/posting/post-scheduler.service.ts`
- Modify: `src/bot/handlers/command.handler.ts`
- Modify: `src/core/session/session.service.ts`

### 7a — Remove all `[RC-DEBUG]` logs

- [ ] **Step 1: Remove from `forward.handler.ts`**

Delete these three lines (they won't be sequential after the earlier deletion; locate by searching for `[RC-DEBUG]`):

```typescript
// DELETE this line (~line 133):
logger.info(`[RC-DEBUG] handler received: id=${message.message_id}, type=${Object.keys(message).filter(k => ['text','photo','video','document','animation','poll'].includes(k))[0] ?? 'other'}, mediaGroupId=${mediaGroupId ?? 'none'}, forwardType=${message.forward_origin?.type ?? 'none'}`);

// DELETE this line (~line 179):
logger.info(`[RC-DEBUG] incoming msg: id=${message.message_id}, forwardType=${forwardOrigin?.type ?? 'none'}`);

// DELETE this line (~line 463):
logger.info(`[RC-DEBUG] session created: id=${sessionId}, messageCount=${messages.length}, ids=[${messages.map((m) => m.message_id).join(',')}], updateResult=${updatedSession ? `ok(${updatedSession.replyChainMessages?.length})` : 'null'}`);
```

- [ ] **Step 2: Remove from `post-publisher.service.ts`**

Delete this line (~line 46 in `copyMessage`):
```typescript
logger.info(`[RC-DEBUG] copyMessage: replyChainIds=${JSON.stringify(post.originalForward.replyChainMessageIds)}, mediaGroupIds=${JSON.stringify(post.originalForward.mediaGroupMessageIds)}, chatId=${post.originalForward.chatId}`);
```

### 7b — Fix dead code in `forward.handler.ts`

- [ ] **Step 3: Fix `messageType` dead code**

In `processSingleMessage`, find:
```typescript
const messageType = forwardInfo ? 'post' : 'message';
await ctx.reply(`📍 Select target channel for this ${messageType}:${greenListNote}`, {
```

Replace with:
```typescript
await ctx.reply(`📍 Select target channel for this post:${greenListNote}`, {
```

### 7c — Fix unnecessary transform in `post-scheduler.service.ts`

- [ ] **Step 4: Remove unnecessary transform call in `scheduleForwardPost`**

In `src/core/posting/post-scheduler.service.ts`, find in `scheduleForwardPost`:
```typescript
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
```

Replace with:
```typescript
const processedContent = {
  ...content,
  text: content.text ?? '',
};
```

Also remove the now-unused import of `transformerService` from `post-scheduler.service.ts` if it's only used there. Check the imports at the top of that file:

```typescript
import { transformerService } from '../../services/transformer.service.js';
```

Remove that import line if `transformerService` is no longer referenced in the file.

### 7d — Fix parallel arrays in `command.handler.ts`

- [ ] **Step 5: Fix the `/interval` command in `command.handler.ts`**

Find:
```typescript
const intervals = await Promise.all(channels.map((ch) => getPostInterval(ch.channelId)));
const lines = channels
  .map((ch, i) => `• ${ch.channelTitle ?? ch.channelId} — ${intervals[i]} min`)
  .join('\n');
```

Replace with:
```typescript
const rows = await Promise.all(
  channels.map(async (ch) => ({ ch, interval: await getPostInterval(ch.channelId) }))
);
const lines = rows
  .map(({ ch, interval }) => `• ${ch.channelTitle ?? ch.channelId} — ${interval} min`)
  .join('\n');
```

### 7e — Remove redundant JSDoc from `session.service.ts`

- [ ] **Step 6: Strip JSDoc blocks that merely restate the function name**

In `src/core/session/session.service.ts`, remove these comment blocks (leave any comment that explains a non-obvious constraint):

```typescript
// REMOVE:
/**
 * Create a new session for a user message
 */

// REMOVE:
/**
 * Find a session by user ID and message ID
 */

// REMOVE:
/**
 * Find a session by ID
 */

// REMOVE:
/**
 * Update session state and data
 */

// REMOVE:
/**
 * Update session data without changing state
 */

// REMOVE:
/**
 * Mark session as completed and delete it
 */

// REMOVE:
/**
 * Clean up expired sessions
 * Returns number of sessions cleaned up
 */

// REMOVE:
/**
 * Get all active sessions for a user
 */

// KEEP (non-obvious sentinel value):
/**
 * Create a session for editing an existing scheduled post.
 * No originalMessage — edit callbacks use sessionId directly.
 * messageId: 0 is a sentinel (Telegram IDs start at 1).
 */

// KEEP (non-obvious behaviour):
/**
 * Find session waiting for custom text input
 */
```

- [ ] **Step 7: Verify everything compiles**

```bash
npm run build
```

Expected: clean build with no errors.

- [ ] **Step 8: Run existing tests**

```bash
npm test
```

Expected: all tests pass (no logic was changed, only moved and cleaned).

- [ ] **Step 9: Commit all style fixes**

```bash
git add src/bot/handlers/forward.handler.ts \
        src/core/posting/post-publisher.service.ts \
        src/core/posting/post-scheduler.service.ts \
        src/bot/handlers/command.handler.ts \
        src/core/session/session.service.ts
git commit -m "refactor: style cleanup — remove RC-DEBUG logs, fix parallel arrays, dead code, redundant JSDoc"
```
