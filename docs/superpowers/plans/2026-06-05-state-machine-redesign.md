# State Machine Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the nested switch-based `getNextState` with a flat, declarative `TRANSITIONS` edge array whose pure `transition()` function returns the next DB state, session field updates, and UI step in one call — eliminating all routing logic from callback handlers.

**Architecture:** `FlowEvent` / `FlowStep` types live in `flow-states.ts`. The `TRANSITIONS` array and `transition()` interpreter live in `session-state-machine.ts`. A `STEP_RENDERERS` record in `shared.ts` maps each `FlowStep` to a renderer. Each callback gathers async data, builds a typed event, calls `transition()`, then persists and renders — no `if/else` routing.

**Tech Stack:** TypeScript, Vitest (`npm test`), Grammy

---

## File Map

| File | Action | What changes |
|------|--------|--------------|
| `src/shared/constants/flow-states.ts` | Modify | Add `FlowEvent`, `FlowStep`; remove `SessionContext` |
| `src/core/session/session-state-machine.ts` | Rewrite | `EdgeDefinition`, `edge()`, `TRANSITIONS`, `transition()` |
| `src/core/session/__tests__/session-state-machine.test.ts` | Rewrite | Pure Vitest tests covering all 10 edges |
| `src/bot/handlers/callbacks/shared.ts` | Modify | Add `computeIsPlainText`, `resolveKnownNicknameUserId`, `STEP_RENDERERS`, `renderStep`; remove `handleNicknameSelection` |
| `src/bot/handlers/callbacks/scheduling.ts` | Modify | Simplify 6 callbacks to use `transition()` + `renderStep()` |

---

## Task 1: Add FlowEvent and FlowStep to flow-states.ts

**Files:**
- Modify: `src/shared/constants/flow-states.ts`

- [ ] **Step 1: Replace the file contents**

```typescript
// src/shared/constants/flow-states.ts

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

export type FlowEvent =
  | Readonly<{ type: 'CHANNEL_SELECTED'; channelId: string; isGreenListed: boolean; isPoll: boolean }>
  | Readonly<{
      type: 'ACTION_SELECTED';
      action: 'transform' | 'forward' | 'quick';
      hasText: boolean;
      hasBlockquotes: boolean;
      isPlainText: boolean;
      fromUserId?: number;
      knownNicknameUserId?: number;
    }>
  | Readonly<{
      type: 'TEXT_HANDLING_SELECTED';
      handling: 'keep' | 'remove' | 'quote';
      knownNicknameUserId?: number;
      isPlainText: boolean;
    }>
  | Readonly<{ type: 'NICKNAME_SELECTED'; userId: number | null; isPlainText: boolean }>
  | Readonly<{ type: 'CUSTOM_TEXT_SELECTED'; text?: string }>

export type FlowStep =
  | { type: 'show_action_select' }
  | { type: 'show_text_handling' }
  | { type: 'show_nickname_select' }
  | { type: 'show_custom_text' }
  | { type: 'show_preview' }
```

- [ ] **Step 2: Build to confirm no downstream breakage yet**

```bash
npm run build
```

Expected: TypeScript errors in `session-state-machine.ts` (imports `SessionContext` which no longer exists) and `scheduling.ts` (imports `getNextState`). That's fine — they'll be fixed in later tasks. If there are errors elsewhere, fix them before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/shared/constants/flow-states.ts
git commit -m "feat: add FlowEvent and FlowStep types to flow-states"
```

---

## Task 2: Rewrite session-state-machine.ts (TDD)

**Files:**
- Rewrite: `src/core/session/session-state-machine.ts`
- Rewrite: `src/core/session/__tests__/session-state-machine.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/core/session/__tests__/session-state-machine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { transition } from '../session-state-machine.js';
import { SessionState } from '../../../shared/constants/flow-states.js';

describe('transition — CHANNEL_SELECT', () => {
  it('goes to PREVIEW and auto-forwards when green-listed', () => {
    const result = transition(SessionState.CHANNEL_SELECT, {
      type: 'CHANNEL_SELECTED', channelId: 'ch1', isGreenListed: true, isPoll: false,
    });
    expect(result.newState).toBe(SessionState.PREVIEW);
    expect(result.step).toEqual({ type: 'show_preview' });
    expect(result.sessionUpdates).toMatchObject({ selectedChannel: 'ch1', selectedAction: 'forward' });
  });

  it('goes to PREVIEW and auto-forwards when message is a poll', () => {
    const result = transition(SessionState.CHANNEL_SELECT, {
      type: 'CHANNEL_SELECTED', channelId: 'ch1', isGreenListed: false, isPoll: true,
    });
    expect(result.newState).toBe(SessionState.PREVIEW);
    expect(result.step).toEqual({ type: 'show_preview' });
    expect(result.sessionUpdates).toMatchObject({ selectedChannel: 'ch1', selectedAction: 'forward' });
  });

  it('goes to ACTION_SELECT for a normal message', () => {
    const result = transition(SessionState.CHANNEL_SELECT, {
      type: 'CHANNEL_SELECTED', channelId: 'ch1', isGreenListed: false, isPoll: false,
    });
    expect(result.newState).toBe(SessionState.ACTION_SELECT);
    expect(result.step).toEqual({ type: 'show_action_select' });
    expect(result.sessionUpdates).toMatchObject({ selectedChannel: 'ch1' });
  });
});

describe('transition — ACTION_SELECT', () => {
  const base = { hasText: false, hasBlockquotes: false, isPlainText: false } as const;

  it('forward action goes to PREVIEW', () => {
    const result = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'forward', ...base,
    });
    expect(result.newState).toBe(SessionState.PREVIEW);
    expect(result.step).toEqual({ type: 'show_preview' });
    expect(result.sessionUpdates).toMatchObject({ selectedAction: 'forward' });
  });

  it('quick action goes to PREVIEW with remove text handling', () => {
    const result = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'quick', ...base, fromUserId: 99,
    });
    expect(result.newState).toBe(SessionState.PREVIEW);
    expect(result.step).toEqual({ type: 'show_preview' });
    expect(result.sessionUpdates).toMatchObject({ selectedAction: 'transform', textHandling: 'remove', selectedUserId: 99 });
  });

  it('quick action with no fromUserId stores null for selectedUserId', () => {
    const result = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'quick', ...base,
    });
    expect(result.sessionUpdates).toMatchObject({ selectedUserId: null });
  });

  it('transform with no text goes to NICKNAME_SELECT', () => {
    const result = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'transform', ...base,
    });
    expect(result.newState).toBe(SessionState.NICKNAME_SELECT);
    expect(result.step).toEqual({ type: 'show_nickname_select' });
    expect(result.sessionUpdates).toMatchObject({ selectedAction: 'transform' });
  });

  it('transform with blockquoted text skips text handling and keeps text', () => {
    const result = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'transform', hasText: true, hasBlockquotes: true, isPlainText: false,
    });
    expect(result.newState).toBe(SessionState.NICKNAME_SELECT);
    expect(result.step).toEqual({ type: 'show_nickname_select' });
    expect(result.sessionUpdates).toMatchObject({ selectedAction: 'transform', textHandling: 'keep' });
  });

  it('transform with plain text goes to NICKNAME_SELECT and skips to show_custom_text when nickname known', () => {
    const result = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'transform', ...base, knownNicknameUserId: 42,
    });
    expect(result.newState).toBe(SessionState.NICKNAME_SELECT);
    expect(result.step).toEqual({ type: 'show_custom_text' });
    expect(result.sessionUpdates).toMatchObject({ selectedUserId: 42 });
  });

  it('transform with isPlainText + known nickname skips to show_preview', () => {
    const result = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'transform', hasText: false, hasBlockquotes: false, isPlainText: true, knownNicknameUserId: 42,
    });
    expect(result.newState).toBe(SessionState.NICKNAME_SELECT);
    expect(result.step).toEqual({ type: 'show_preview' });
    expect(result.sessionUpdates).toMatchObject({ selectedUserId: 42 });
  });

  it('transform with text and no blockquotes goes to TEXT_HANDLING', () => {
    const result = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'transform', hasText: true, hasBlockquotes: false, isPlainText: false,
    });
    expect(result.newState).toBe(SessionState.TEXT_HANDLING);
    expect(result.step).toEqual({ type: 'show_text_handling' });
    expect(result.sessionUpdates).toMatchObject({ selectedAction: 'transform' });
  });
});

describe('transition — TEXT_HANDLING', () => {
  it('stores handling choice and shows nickname select', () => {
    const result = transition(SessionState.TEXT_HANDLING, {
      type: 'TEXT_HANDLING_SELECTED', handling: 'quote', isPlainText: false,
    });
    expect(result.newState).toBe(SessionState.NICKNAME_SELECT);
    expect(result.step).toEqual({ type: 'show_nickname_select' });
    expect(result.sessionUpdates).toMatchObject({ textHandling: 'quote' });
  });

  it('auto-skips nickname select when nickname is known', () => {
    const result = transition(SessionState.TEXT_HANDLING, {
      type: 'TEXT_HANDLING_SELECTED', handling: 'keep', isPlainText: false, knownNicknameUserId: 7,
    });
    expect(result.step).toEqual({ type: 'show_custom_text' });
    expect(result.sessionUpdates).toMatchObject({ textHandling: 'keep', selectedUserId: 7 });
  });

  it('auto-skips to show_preview for plain text with known nickname', () => {
    const result = transition(SessionState.TEXT_HANDLING, {
      type: 'TEXT_HANDLING_SELECTED', handling: 'remove', isPlainText: true, knownNicknameUserId: 7,
    });
    expect(result.step).toEqual({ type: 'show_preview' });
  });
});

describe('transition — NICKNAME_SELECT', () => {
  it('goes to CUSTOM_TEXT for a regular message', () => {
    const result = transition(SessionState.NICKNAME_SELECT, {
      type: 'NICKNAME_SELECTED', userId: 5, isPlainText: false,
    });
    expect(result.newState).toBe(SessionState.CUSTOM_TEXT);
    expect(result.step).toEqual({ type: 'show_custom_text' });
    expect(result.sessionUpdates).toMatchObject({ selectedUserId: 5 });
  });

  it('goes to PREVIEW for a plain-text message', () => {
    const result = transition(SessionState.NICKNAME_SELECT, {
      type: 'NICKNAME_SELECTED', userId: null, isPlainText: true,
    });
    expect(result.newState).toBe(SessionState.PREVIEW);
    expect(result.step).toEqual({ type: 'show_preview' });
    expect(result.sessionUpdates).toMatchObject({ selectedUserId: null });
  });
});

describe('transition — CUSTOM_TEXT', () => {
  it('stores text and goes to PREVIEW', () => {
    const result = transition(SessionState.CUSTOM_TEXT, {
      type: 'CUSTOM_TEXT_SELECTED', text: 'hello',
    });
    expect(result.newState).toBe(SessionState.PREVIEW);
    expect(result.step).toEqual({ type: 'show_preview' });
    expect(result.sessionUpdates).toMatchObject({ customText: 'hello' });
  });

  it('goes to PREVIEW with no text when skipped', () => {
    const result = transition(SessionState.CUSTOM_TEXT, {
      type: 'CUSTOM_TEXT_SELECTED',
    });
    expect(result.newState).toBe(SessionState.PREVIEW);
    expect(result.step).toEqual({ type: 'show_preview' });
  });
});

describe('transition — error cases', () => {
  it('throws when no edge matches', () => {
    expect(() =>
      transition(SessionState.PREVIEW, { type: 'CHANNEL_SELECTED', channelId: 'x', isGreenListed: false, isPoll: false })
    ).toThrow('No transition: preview + CHANNEL_SELECTED');
  });
});
```

- [ ] **Step 2: Run tests — expect failure (transition is not yet exported)**

```bash
npm test -- session-state-machine
```

Expected: all tests fail with import error or "transition is not a function".

- [ ] **Step 3: Implement session-state-machine.ts**

Replace the entire contents of `src/core/session/session-state-machine.ts`:

```typescript
import { SessionState } from '../../shared/constants/flow-states.js';
import type { FlowEvent, FlowStep } from '../../shared/constants/flow-states.js';
import type { ISession } from '../../database/models/session.model.js';

export type TransitionResult = Readonly<{
  newState: SessionState;
  step: FlowStep;
  sessionUpdates: Readonly<Partial<ISession>>;
}>;

interface EdgeDefinition {
  readonly from: SessionState;
  readonly on: FlowEvent['type'];
  readonly when?: (event: FlowEvent) => boolean;
  readonly to: SessionState;
  readonly step: FlowStep | ((event: FlowEvent) => FlowStep);
  readonly updates: (event: FlowEvent) => Readonly<Partial<ISession>>;
}

function edge<ET extends FlowEvent['type']>(e: {
  from: SessionState;
  on: ET;
  when?: (event: Extract<FlowEvent, { type: ET }>) => boolean;
  to: SessionState;
  step: FlowStep | ((event: Extract<FlowEvent, { type: ET }>) => FlowStep);
  updates: (event: Extract<FlowEvent, { type: ET }>) => Readonly<Partial<ISession>>;
}): EdgeDefinition {
  return e as EdgeDefinition;
}

const nicknameStep = (e: { knownNicknameUserId?: number; isPlainText: boolean }): FlowStep => {
  if (e.knownNicknameUserId != null) {
    return e.isPlainText ? { type: 'show_preview' } : { type: 'show_custom_text' };
  }
  return { type: 'show_nickname_select' };
};

const TRANSITIONS: readonly EdgeDefinition[] = [
  // ── CHANNEL_SELECT ──────────────────────────────────────────────────────────
  edge({
    from: SessionState.CHANNEL_SELECT, on: 'CHANNEL_SELECTED',
    when: e => e.isGreenListed || e.isPoll,
    to: SessionState.PREVIEW,
    step: { type: 'show_preview' },
    updates: e => ({ selectedChannel: e.channelId, selectedAction: 'forward' }),
  }),
  edge({
    from: SessionState.CHANNEL_SELECT, on: 'CHANNEL_SELECTED',
    to: SessionState.ACTION_SELECT,
    step: { type: 'show_action_select' },
    updates: e => ({ selectedChannel: e.channelId }),
  }),

  // ── ACTION_SELECT ────────────────────────────────────────────────────────────
  edge({
    from: SessionState.ACTION_SELECT, on: 'ACTION_SELECTED',
    when: e => e.action === 'forward',
    to: SessionState.PREVIEW,
    step: { type: 'show_preview' },
    updates: () => ({ selectedAction: 'forward' }),
  }),
  edge({
    from: SessionState.ACTION_SELECT, on: 'ACTION_SELECTED',
    when: e => e.action === 'quick',
    to: SessionState.PREVIEW,
    step: { type: 'show_preview' },
    updates: e => ({ selectedAction: 'transform', textHandling: 'remove', selectedUserId: e.fromUserId ?? null }),
  }),
  edge({
    from: SessionState.ACTION_SELECT, on: 'ACTION_SELECTED',
    when: e => e.action === 'transform' && (!e.hasText || e.hasBlockquotes),
    to: SessionState.NICKNAME_SELECT,
    step: nicknameStep,
    updates: e => ({
      selectedAction: 'transform',
      ...(e.hasBlockquotes && { textHandling: 'keep' }),
      ...(e.knownNicknameUserId != null && { selectedUserId: e.knownNicknameUserId }),
    }),
  }),
  edge({
    from: SessionState.ACTION_SELECT, on: 'ACTION_SELECTED',
    when: e => e.action === 'transform' && e.hasText,
    to: SessionState.TEXT_HANDLING,
    step: { type: 'show_text_handling' },
    updates: () => ({ selectedAction: 'transform' }),
  }),

  // ── TEXT_HANDLING ────────────────────────────────────────────────────────────
  edge({
    from: SessionState.TEXT_HANDLING, on: 'TEXT_HANDLING_SELECTED',
    to: SessionState.NICKNAME_SELECT,
    step: nicknameStep,
    updates: e => ({
      textHandling: e.handling,
      ...(e.knownNicknameUserId != null && { selectedUserId: e.knownNicknameUserId }),
    }),
  }),

  // ── NICKNAME_SELECT ──────────────────────────────────────────────────────────
  edge({
    from: SessionState.NICKNAME_SELECT, on: 'NICKNAME_SELECTED',
    when: e => e.isPlainText,
    to: SessionState.PREVIEW,
    step: { type: 'show_preview' },
    updates: e => ({ selectedUserId: e.userId }),
  }),
  edge({
    from: SessionState.NICKNAME_SELECT, on: 'NICKNAME_SELECTED',
    to: SessionState.CUSTOM_TEXT,
    step: { type: 'show_custom_text' },
    updates: e => ({ selectedUserId: e.userId }),
  }),

  // ── CUSTOM_TEXT ──────────────────────────────────────────────────────────────
  edge({
    from: SessionState.CUSTOM_TEXT, on: 'CUSTOM_TEXT_SELECTED',
    to: SessionState.PREVIEW,
    step: { type: 'show_preview' },
    updates: e => ({ customText: e.text }),
  }),
];

export function transition(state: SessionState, event: FlowEvent): TransitionResult {
  const matched = TRANSITIONS.find(
    t => t.from === state && t.on === event.type && (t.when?.(event) ?? true)
  );
  if (!matched) throw new Error(`No transition: ${state} + ${event.type}`);
  return Object.freeze({
    newState: matched.to,
    step: typeof matched.step === 'function' ? matched.step(event) : matched.step,
    sessionUpdates: Object.freeze(matched.updates(event)),
  });
}
```

- [ ] **Step 4: Run tests — expect all to pass**

```bash
npm test -- session-state-machine
```

Expected: all 17 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/session/session-state-machine.ts src/core/session/__tests__/session-state-machine.test.ts
git commit -m "feat: rewrite state machine as declarative edge array"
```

---

## Task 3: Add helpers and renderStep to shared.ts

**Files:**
- Modify: `src/bot/handlers/callbacks/shared.ts`

- [ ] **Step 1: Add new imports at the top of shared.ts**

Add these imports after the existing ones:

```typescript
import type { Message } from 'grammy/types';
import type { FlowStep } from '../../../shared/constants/flow-states.js';
import type { ForwardInfo } from '../../../types/message.types.js';
import { createForwardActionKeyboard } from '../../keyboards/forward-action.keyboard.js';
import { createTextHandlingKeyboard } from '../../keyboards/text-handling.keyboard.js';
```

(`Message` and `ForwardInfo` may already be imported — check first and skip duplicates.)

- [ ] **Step 2: Add computeIsPlainText helper (after the existing imports, before the first function)**

```typescript
export function computeIsPlainText(message: Message): boolean {
  return (
    message.text !== undefined &&
    !('photo' in message && message.photo) &&
    !('video' in message && message.video) &&
    !('document' in message && message.document) &&
    !('animation' in message && message.animation) &&
    !('external_reply' in message && (message as Record<string, unknown>).external_reply) &&
    !message.forward_origin
  );
}
```

- [ ] **Step 3: Add resolveKnownNicknameUserId helper**

```typescript
export async function resolveKnownNicknameUserId(forwardInfo: ForwardInfo): Promise<number | undefined> {
  const { fromUserId } = forwardInfo;
  if (!fromUserId) return undefined;
  const nickname = await findNicknameByUserId(fromUserId);
  return nickname ? fromUserId : undefined;
}
```

- [ ] **Step 4: Add STEP_RENDERERS and renderStep**

```typescript
type StepRenderer = (ctx: Context, sessionId: string) => Promise<void>;

const STEP_RENDERERS: Record<FlowStep['type'], StepRenderer> = {
  show_action_select: ctx =>
    ctx.editMessageText(
      'Choose how to post this message:\n⚡ <b>Quick post</b> — transform, no attribution, no extra text',
      { reply_markup: createForwardActionKeyboard(), parse_mode: 'HTML' }
    ),
  show_text_handling: ctx =>
    ctx.editMessageText('How should the text be handled?', { reply_markup: createTextHandlingKeyboard() }),
  show_nickname_select: async ctx =>
    ctx.editMessageText('Who should be credited for this post?', { reply_markup: await getNicknameKeyboard() }),
  show_custom_text: async ctx =>
    ctx.editMessageText('Do you want to add custom text to this post?', {
      reply_markup: await createCustomTextKeyboard(),
    }),
  show_preview: (ctx, sessionId) => showPreview(ctx, sessionId),
};

export const renderStep = (ctx: Context, step: FlowStep, sessionId: string): Promise<void> =>
  STEP_RENDERERS[step.type](ctx, sessionId);
```

- [ ] **Step 5: Build to verify**

```bash
npm run build
```

Expected: errors only in `scheduling.ts` (still imports old API). Fix none yet — those come in Tasks 4–7.

- [ ] **Step 6: Commit**

```bash
git add src/bot/handlers/callbacks/shared.ts
git commit -m "feat: add renderStep, computeIsPlainText, resolveKnownNicknameUserId to shared"
```

---

## Task 4: Migrate the channel selection callback

**Files:**
- Modify: `src/bot/handlers/callbacks/scheduling.ts`

- [ ] **Step 1: Update imports in scheduling.ts**

Replace:
```typescript
import { getNextState } from '../../../core/session/session-state-machine.js';
```
With:
```typescript
import { transition } from '../../../core/session/session-state-machine.js';
import type { FlowEvent } from '../../../shared/constants/flow-states.js';
```

Also add to the `shared.ts` import:
```typescript
import {
  getSessionService,
  deletePreviewMessages,
  showPreview,
  renderStep,
} from './shared.js';
```

(Remove `handleNicknameSelection` from the shared import — it will be deleted later.)

- [ ] **Step 2: Replace the select_channel callback body**

Find the `bot.callbackQuery(/^select_channel:(.+)$/, ...)` handler. Replace everything from after `session.isReply` branch (which stays unchanged) down to the closing `}` of the non-reply path:

The full non-reply section currently ends with the manual keyboard show. Replace it so it becomes:

```typescript
      // Reply sessions are handled separately — out of scope for this refactor
      if (session?.isReply) {
        await sessionSvc.updateState(session._id.toString(), SessionState.REPLY_SLOT_CHOICE, {
          selectedChannel: selectedChannelId,
        });
        const slotKeyboard = createReplySlotKeyboard(session._id.toString());
        await ctx.editMessageText('When should this reply be sent?', { reply_markup: slotKeyboard });
        return;
      }

      const forwardInfo = parseForwardInfo(originalMessage);
      const shouldAutoForward = await transformerService.shouldAutoForward(forwardInfo);
      const content = extractMessageContent(originalMessage);
      const isPoll = content?.type === 'poll';

      if (!session || !sessionSvc) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      const event: FlowEvent = {
        type: 'CHANNEL_SELECTED',
        channelId: selectedChannelId,
        isGreenListed: shouldAutoForward,
        isPoll,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await sessionSvc.updateState(session._id.toString(), newState, sessionUpdates);
      await renderStep(ctx, step, session._id.toString());

      logger.debug(`Channel ${selectedChannelId} selected for message ${originalMessage.message_id}`);
```

- [ ] **Step 3: Build to verify**

```bash
npm run build
```

Expected: fewer errors than before (channel callback is clean). Remaining errors are in the other callbacks still using old API.

- [ ] **Step 4: Commit**

```bash
git add src/bot/handlers/callbacks/scheduling.ts
git commit -m "refactor: migrate channel selection callback to transition()"
```

---

## Task 5: Migrate action selection callbacks (transform, forward, quick)

**Files:**
- Modify: `src/bot/handlers/callbacks/scheduling.ts`

- [ ] **Step 1: Replace the action:transform callback body**

Find `bot.callbackQuery('action:transform', ...)`. Replace the body from after `const session = await getPendingForward(...)`:

```typescript
      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      const content = extractMessageContent(originalMessage);
      const hasText = !!(content?.text?.trim());
      const hasBlockquotes = hasText && (content?.text?.includes('<blockquote>') ?? false);
      const fullMessage = session.originalMessage ?? originalMessage;
      const isPlainText = computeIsPlainText(fullMessage);
      const forwardInfo = parseForwardInfo(fullMessage);
      const knownNicknameUserId = await resolveKnownNicknameUserId(forwardInfo);

      const event: FlowEvent = {
        type: 'ACTION_SELECTED',
        action: 'transform',
        hasText,
        hasBlockquotes,
        isPlainText,
        fromUserId: forwardInfo.fromUserId,
        knownNicknameUserId,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(session._id.toString(), newState, sessionUpdates);
      await renderStep(ctx, step, session._id.toString());

      logger.debug(`Transform action selected for message ${originalMessage.message_id}`);
```

Also add to the imports from `shared.ts`:
```typescript
import {
  getSessionService,
  deletePreviewMessages,
  showPreview,
  renderStep,
  computeIsPlainText,
  resolveKnownNicknameUserId,
} from './shared.js';
```

- [ ] **Step 2: Replace the action:forward callback body**

Find `bot.callbackQuery('action:forward', ...)`. Replace body after `const session = await getPendingForward(...)`:

```typescript
      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      const event: FlowEvent = {
        type: 'ACTION_SELECTED',
        action: 'forward',
        hasText: false,
        hasBlockquotes: false,
        isPlainText: false,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(session._id.toString(), newState, sessionUpdates);
      await renderStep(ctx, step, session._id.toString());

      logger.debug(`Forward action selected for message ${originalMessage.message_id}`);
```

- [ ] **Step 3: Replace the action:quick callback body**

Find `bot.callbackQuery('action:quick', ...)`. Replace body after `const session = await getPendingForward(...)`:

```typescript
      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      if (!session) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      const forwardInfo = parseForwardInfo(originalMessage);

      const event: FlowEvent = {
        type: 'ACTION_SELECTED',
        action: 'quick',
        hasText: false,
        hasBlockquotes: false,
        isPlainText: false,
        fromUserId: forwardInfo.fromUserId,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(session._id.toString(), newState, sessionUpdates);
      await renderStep(ctx, step, session._id.toString());

      logger.debug(`Quick post selected for message ${originalMessage.message_id}`);
```

- [ ] **Step 4: Build to verify**

```bash
npm run build
```

Expected: action callback errors gone. Remaining errors: text handling and nickname callbacks.

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers/callbacks/scheduling.ts
git commit -m "refactor: migrate action callbacks to transition()"
```

---

## Task 6: Migrate text handling and nickname callbacks

**Files:**
- Modify: `src/bot/handlers/callbacks/scheduling.ts`

- [ ] **Step 1: Replace the text:(keep|remove|quote) callback body**

Find `bot.callbackQuery(/^text:(keep|remove|quote)$/, ...)`. Replace body after `const session = await getPendingForward(...)`:

```typescript
      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      const foundKey = session?._id.toString();
      if (!foundKey) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      const fullMessage = session?.originalMessage ?? originalMessage;
      const isPlainText = computeIsPlainText(fullMessage);
      const knownNicknameUserId = await resolveKnownNicknameUserId(parseForwardInfo(fullMessage));

      const event: FlowEvent = {
        type: 'TEXT_HANDLING_SELECTED',
        handling: textHandling,
        isPlainText,
        knownNicknameUserId,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(foundKey, newState, sessionUpdates);
      await renderStep(ctx, step, foundKey);

      logger.debug(`Text handling "${textHandling}" selected for message ${originalMessage.message_id}`);
```

- [ ] **Step 2: Replace the select_nickname callback body**

Find `bot.callbackQuery(/^select_nickname:(.+)$/, ...)`. Replace body after `const session = await getPendingForward(...)`:

```typescript
      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      const foundKey = session?._id.toString();
      if (!foundKey) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      const selectedUserId = nicknameSelection === NICKNAME_NONE_KEY ? null : parseInt(nicknameSelection, 10);
      const fullMessage = session?.originalMessage ?? originalMessage;
      const isPlainText = computeIsPlainText(fullMessage);

      const event: FlowEvent = {
        type: 'NICKNAME_SELECTED',
        userId: selectedUserId,
        isPlainText,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(foundKey, newState, sessionUpdates);
      await renderStep(ctx, step, foundKey);

      logger.debug(`Nickname "${nicknameSelection}" selected for message ${originalMessage.message_id}`);
```

- [ ] **Step 3: Build to verify**

```bash
npm run build
```

Expected: only the custom text callbacks remain with issues (if any). No other errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot/handlers/callbacks/scheduling.ts
git commit -m "refactor: migrate text handling and nickname callbacks to transition()"
```

---

## Task 7: Migrate custom text callbacks

**Files:**
- Modify: `src/bot/handlers/callbacks/scheduling.ts`

The `custom_text:add` case does NOT go through `transition()` — it's a self-loop that only sets `waitingForCustomText: true` and shows a reply prompt. The `custom_text:skip` and `custom_text:preset:id` cases do go through the machine.

- [ ] **Step 1: Replace the custom_text:(add|skip) callback body**

Find `bot.callbackQuery(/^custom_text:(add|skip)$/, ...)`. Replace body after `const session = await getPendingForward(...)`:

```typescript
      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      const foundKey = session?._id.toString();
      if (!foundKey) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      if (action === 'add') {
        // Self-loop: stays in CUSTOM_TEXT state, waits for a reply with the text
        await getSessionService().updateState(foundKey, SessionState.CUSTOM_TEXT, { waitingForCustomText: true });
        await ctx.editMessageText(
          '✍️ Reply to this message with your custom text.\n\n' +
            'This text will be added at the beginning of your post.'
        );
        logger.debug(`Custom text reply prompt shown for message ${originalMessage.message_id}`);
        return;
      }

      const event: FlowEvent = {
        type: 'CUSTOM_TEXT_SELECTED',
        text: undefined,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(foundKey, newState, sessionUpdates);
      await renderStep(ctx, step, foundKey);

      logger.debug(`Custom text skipped for message ${originalMessage.message_id}`);
```

- [ ] **Step 2: Replace the custom_text:preset callback body**

Find `bot.callbackQuery(/^custom_text:preset:(.+)$/, ...)`. Replace body after `const session = await getPendingForward(...)`:

```typescript
      const session = await getPendingForward(ctx.from?.id ?? 0, originalMessage.message_id);
      const foundKey = session?._id.toString();
      if (!foundKey) {
        await ErrorMessages.sessionExpired(ctx);
        return;
      }

      const event: FlowEvent = {
        type: 'CUSTOM_TEXT_SELECTED',
        text: preset.text,
      };

      const { newState, step, sessionUpdates } = transition(session.state, event);
      await getSessionService().updateState(foundKey, newState, sessionUpdates);
      await renderStep(ctx, step, foundKey);

      logger.debug(`Preset custom text "${preset.label}" selected for message ${originalMessage.message_id}`);
```

- [ ] **Step 3: Build to verify**

```bash
npm run build
```

Expected: clean build with zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot/handlers/callbacks/scheduling.ts
git commit -m "refactor: migrate custom text callbacks to transition()"
```

---

## Task 8: Final cleanup

**Files:**
- Modify: `src/bot/handlers/callbacks/shared.ts`
- Modify: `src/bot/handlers/callbacks/scheduling.ts`

- [ ] **Step 1: Delete handleNicknameSelection from shared.ts**

Remove the entire `handleNicknameSelection` function (it was replaced by `resolveKnownNicknameUserId` + `STEP_RENDERERS`).

- [ ] **Step 2: Remove handleNicknameSelection from shared.ts exports and the scheduling.ts import**

In `scheduling.ts`, remove `handleNicknameSelection` from the import line that pulls from `./shared.js`.

- [ ] **Step 3: Remove now-unused imports from scheduling.ts**

These are no longer needed in `scheduling.ts`:
- `createForwardActionKeyboard` (moved into `STEP_RENDERERS` in shared.ts)
- `createTextHandlingKeyboard` (moved into `STEP_RENDERERS`)
- `getNextState` / `SessionContext` (replaced by `transition`)
- `findNicknameByUserId` (moved into `resolveKnownNicknameUserId` in shared.ts)

Check each import and remove only what is no longer referenced in the file.

- [ ] **Step 4: Run lint to catch any remaining unused imports**

```bash
npm run lint
```

Fix any reported issues.

- [ ] **Step 5: Final build**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/bot/handlers/callbacks/shared.ts src/bot/handlers/callbacks/scheduling.ts
git commit -m "refactor: remove handleNicknameSelection and clean up unused imports"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered by |
|-----------------|------------|
| `FlowEvent` type with all 5 variants | Task 1 |
| `FlowStep` type with all 5 variants | Task 1 |
| `TransitionResult` (immutable) | Task 2 |
| `edge()` helper with typed parameters | Task 2 |
| `TRANSITIONS` flat array with all 10 edges | Task 2 |
| `transition()` pure interpreter | Task 2 |
| Vitest unit tests, no mocks | Task 2 |
| `STEP_RENDERERS` record (exhaustive) | Task 3 |
| `renderStep` function | Task 3 |
| `computeIsPlainText` helper | Task 3 |
| `resolveKnownNicknameUserId` helper | Task 3 |
| Channel selection callback migrated | Task 4 |
| Action callbacks (transform/forward/quick) migrated | Task 5 |
| Text handling + nickname callbacks migrated | Task 6 |
| Custom text callbacks migrated | Task 7 |
| `handleNicknameSelection` removed | Task 8 |
| `SessionContext`, `getNextState`, `getPossibleNextStates`, `isValidTransition` removed | Tasks 1+8 |

All spec requirements covered. No placeholders.
