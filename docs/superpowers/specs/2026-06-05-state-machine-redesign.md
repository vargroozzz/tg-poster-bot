# State Machine Redesign

**Date:** 2026-06-05  
**Scope:** Main scheduling flow only (queue-edit flow deferred)

## Problem

The current state machine (`session-state-machine.ts`) only records which DB state to write. All routing decisions — what keyboard to show next, which steps to skip — live in the callback handlers (`scheduling.ts`). This causes:

- Duplicated routing logic across `scheduling.ts` and `callbacks/shared.ts`
- Callers passing fabricated context to `getNextState` (e.g. always `isRedListed: false`, always `isForward: false`)
- Auto-transitions (blockquotes → skip text handling, known nickname → skip selection) scattered across callbacks
- `getPossibleNextStates` is inaccurate and unused
- Adding a new step requires changes in multiple unrelated files

## Solution

Replace the nested switch-based state machine with a **flat, declarative edge array**. Each edge is a plain record with `from`, `on`, `when`, `to`, `step`, and `updates`. The machine becomes a pure function `(SessionState, FlowEvent) → TransitionResult` — no async, no DB, no Telegram API. Callers gather async data first, build a typed event, call `transition()`, then execute the result.

## Types

Defined in `src/shared/constants/flow-states.ts`.

### FlowEvent

One variant per Telegram callback. All async data (green list status, known nickname, etc.) is resolved by the caller before building the event — the machine receives it as plain data.

```typescript
type FlowEvent =
  | Readonly<{ type: 'CHANNEL_SELECTED'; channelId: string; isGreenListed: boolean; isPoll: boolean }>
  | Readonly<{ type: 'ACTION_SELECTED'; action: 'transform' | 'forward' | 'quick';
               hasText: boolean; hasBlockquotes: boolean; isPlainText: boolean;
               fromUserId?: number; knownNicknameUserId?: number }>
  | Readonly<{ type: 'TEXT_HANDLING_SELECTED'; handling: 'keep' | 'remove' | 'quote';
               knownNicknameUserId?: number; isPlainText: boolean }>
  | Readonly<{ type: 'NICKNAME_SELECTED'; userId: number | null; isPlainText: boolean }>
  | Readonly<{ type: 'CUSTOM_TEXT_SELECTED'; text?: string }>
```

### FlowStep

What the caller must render after the transition. Exhaustive — TypeScript errors if a new step is added without a renderer.

```typescript
type FlowStep =
  | { type: 'show_action_select' }
  | { type: 'show_text_handling' }
  | { type: 'show_nickname_select' }
  | { type: 'show_custom_text' }
  | { type: 'show_preview' }
```

### TransitionResult

Everything the caller needs. Immutable via `Object.freeze`.

```typescript
type TransitionResult = Readonly<{
  newState: SessionState;
  step: FlowStep;
  sessionUpdates: Readonly<Partial<ISession>>;
}>
```

`SessionContext` is removed — replaced by `FlowEvent` which carries richer, accurately-typed data.

## State Machine

Defined in `src/core/session/session-state-machine.ts`.

### Edge helper

Captures the event type at definition time so `when`, `step`, and `updates` are fully typed to the specific event subtype:

```typescript
function edge<ET extends FlowEvent['type']>(e: {
  from: SessionState;
  on: ET;
  when?: (event: Extract<FlowEvent, { type: ET }>) => boolean;
  to: SessionState;
  step: FlowStep | ((event: Extract<FlowEvent, { type: ET }>) => FlowStep);
  updates: (event: Extract<FlowEvent, { type: ET }>) => Readonly<Partial<ISession>>;
}) { return e; }
```

### TRANSITIONS array

Flat array of edges. Checked in order — first edge whose `from`, `on`, and `when` all match wins. Missing `when` means unconditional (always matches).

```
CHANNEL_SELECT --[CHANNEL_SELECTED, isGreenListed || isPoll]--> PREVIEW (show_preview)
CHANNEL_SELECT --[CHANNEL_SELECTED]--> ACTION_SELECT (show_action_select)

ACTION_SELECT --[ACTION_SELECTED, action=forward]--> PREVIEW (show_preview)
ACTION_SELECT --[ACTION_SELECTED, action=quick]--> PREVIEW (show_preview)
ACTION_SELECT --[ACTION_SELECTED, action=transform, !hasText || hasBlockquotes]--> NICKNAME_SELECT (show_nickname_select | show_custom_text | show_preview)
ACTION_SELECT --[ACTION_SELECTED, action=transform, hasText]--> TEXT_HANDLING (show_text_handling)

TEXT_HANDLING --[TEXT_HANDLING_SELECTED]--> NICKNAME_SELECT (show_nickname_select | show_custom_text | show_preview)

NICKNAME_SELECT --[NICKNAME_SELECTED, isPlainText]--> PREVIEW (show_preview)
NICKNAME_SELECT --[NICKNAME_SELECTED]--> CUSTOM_TEXT (show_custom_text)

CUSTOM_TEXT --[CUSTOM_TEXT_SELECTED]--> PREVIEW (show_preview)
```

Auto-transitions embedded as edge logic:
- **Blockquotes** → `hasBlockquotes` flag on `ACTION_SELECTED`, edge skips TEXT_HANDLING and writes `textHandling: 'keep'` in `sessionUpdates`
- **Known nickname** → `knownNicknameUserId` on event, edge skips to `show_custom_text` (or `show_preview` if plain text) and writes `selectedUserId` in `sessionUpdates`
- **Green list / poll** → handled at `CHANNEL_SELECT` level, jumps directly to `show_preview`

### Interpreter

```typescript
export function transition(state: SessionState, event: FlowEvent): TransitionResult {
  const matched = TRANSITIONS.find(
    t => t.from === state && t.on === event.type && (t.when?.(event as never) ?? true)
  );
  if (!matched) throw new Error(`No transition: ${state} + ${event.type}`);
  return Object.freeze({
    newState: matched.to,
    step: typeof matched.step === 'function' ? matched.step(event as never) : matched.step,
    sessionUpdates: Object.freeze(matched.updates(event as never)),
  });
}
```

`getPossibleNextStates` and `isValidTransition` are removed — they were inaccurate and unused.

## Rendering

`STEP_RENDERERS` in `src/bot/handlers/callbacks/shared.ts` — a `Record<FlowStep['type'], StepRenderer>`. TypeScript enforces exhaustiveness: adding a new `FlowStep` variant without a renderer is a compile error.

```typescript
type StepRenderer = (ctx: Context, sessionId: string) => Promise<void>;

const STEP_RENDERERS: Record<FlowStep['type'], StepRenderer> = {
  show_action_select:   ctx => ctx.editMessageText('...', { reply_markup: createForwardActionKeyboard() }),
  show_text_handling:   ctx => ctx.editMessageText('...', { reply_markup: createTextHandlingKeyboard() }),
  show_nickname_select: ctx => ctx.editMessageText('...', { reply_markup: await getNicknameKeyboard() }),
  show_custom_text:     ctx => ctx.editMessageText('...', { reply_markup: await createCustomTextKeyboard() }),
  show_preview:        (ctx, sessionId) => showPreview(ctx, sessionId),
};

export const renderStep = (ctx: Context, step: FlowStep, sessionId: string): Promise<void> =>
  STEP_RENDERERS[step.type](ctx, sessionId);
```

## Callback skeleton

Every callback in `scheduling.ts` follows the same pattern after this change:

```typescript
// 1. Resolve session
const session = await getPendingForward(ctx.from.id, originalMessage.message_id);

// 2. Gather all async data
const knownNicknameUserId = await resolveKnownNickname(parseForwardInfo(originalMessage));

// 3. Build typed event
const event: FlowEvent = { type: 'ACTION_SELECTED', action: 'transform', hasText, hasBlockquotes, isPlainText, knownNicknameUserId };

// 4. Transition (pure)
const { newState, step, sessionUpdates } = transition(session.state, event);

// 5. Persist + render
await sessionSvc.updateState(session._id, newState, sessionUpdates);
await renderStep(ctx, step, session._id.toString());
```

No routing logic in callbacks. No `if/else` to decide which keyboard to show.

## Files Changed

| File | Change |
|------|--------|
| `src/shared/constants/flow-states.ts` | Add `FlowEvent`, `FlowStep`, `TransitionResult`; remove `SessionContext` |
| `src/core/session/session-state-machine.ts` | Rewrite: `edge()` helper + `TRANSITIONS` array + `transition()` interpreter |
| `src/bot/handlers/callbacks/shared.ts` | Add `STEP_RENDERERS` record + `renderStep` function |
| `src/bot/handlers/callbacks/scheduling.ts` | Simplify all 6 callbacks to use `transition()` + `renderStep()` |
| `src/core/session/__tests__/session-state-machine.test.ts` | Expand pure unit tests — no mocks required |

## Testing

The machine is a pure function — tests need zero mocks:

```typescript
it('skips text handling when text has blockquotes', () => {
  const result = transition(SessionState.ACTION_SELECT, {
    type: 'ACTION_SELECTED', action: 'transform',
    hasText: true, hasBlockquotes: true, isPlainText: false,
  });
  expect(result.newState).toBe(SessionState.NICKNAME_SELECT);
  expect(result.step).toEqual({ type: 'show_nickname_select' });
  expect(result.sessionUpdates).toMatchObject({ selectedAction: 'transform', textHandling: 'keep' });
});

it('auto-selects known nickname and skips to custom text', () => {
  const result = transition(SessionState.ACTION_SELECT, {
    type: 'ACTION_SELECTED', action: 'transform',
    hasText: false, hasBlockquotes: false, isPlainText: false,
    knownNicknameUserId: 42,
  });
  expect(result.step).toEqual({ type: 'show_custom_text' });
  expect(result.sessionUpdates).toMatchObject({ selectedUserId: 42 });
});
```

## Out of Scope

- Queue-edit flow (`queue.ts`) — deferred, tackled separately after this lands
- Reply flow states (`WAITING_FOR_REPLY_CONTENT`, `REPLY_SLOT_CHOICE`) — unchanged, they bypass the main flow entirely
