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
  readonly to: (event: FlowEvent) => SessionState;
  readonly updates: (event: FlowEvent) => Readonly<Partial<ISession>>;
}

function edge<ET extends FlowEvent['type']>(e: {
  from: SessionState;
  on: ET;
  when?: (event: Extract<FlowEvent, { type: ET }>) => boolean;
  to: (event: Extract<FlowEvent, { type: ET }>) => SessionState;
  updates: (event: Extract<FlowEvent, { type: ET }>) => Readonly<Partial<ISession>>;
}): EdgeDefinition {
  return e as unknown as EdgeDefinition;
}

// Entering a state always shows that state's UI, so the step is derived from the
// destination (see transition) rather than carried on every edge.
const STEP_BY_STATE: Partial<Record<SessionState, FlowStep>> = {
  [SessionState.ACTION_SELECT]: { type: 'show_action_select' },
  [SessionState.TEXT_HANDLING]: { type: 'show_text_handling' },
  [SessionState.NICKNAME_SELECT]: { type: 'show_nickname_select' },
  [SessionState.PREVIEW]: { type: 'show_preview' },
};

// The text-choice step is the last one before attribution, so a known nickname is
// the only thing that can still skip the nickname step.
const afterTextCustom = (knownNicknameUserId?: number): SessionState =>
  knownNicknameUserId != null ? SessionState.PREVIEW : SessionState.NICKNAME_SELECT;

const TRANSITIONS: readonly EdgeDefinition[] = [
  // ── CHANNEL_SELECT ──────────────────────────────────────────────────────────
  edge({
    from: SessionState.CHANNEL_SELECT, on: 'CHANNEL_SELECTED',
    when: e => e.isGreenListed || e.isPoll,
    to: () => SessionState.PREVIEW,
    updates: e => ({ selectedChannel: e.channelId, selectedAction: 'forward' }),
  }),
  edge({
    from: SessionState.CHANNEL_SELECT, on: 'CHANNEL_SELECTED',
    to: () => SessionState.ACTION_SELECT,
    updates: e => ({ selectedChannel: e.channelId }),
  }),

  // ── ACTION_SELECT ────────────────────────────────────────────────────────────
  edge({
    from: SessionState.ACTION_SELECT, on: 'ACTION_SELECTED',
    when: e => e.action === 'forward',
    to: () => SessionState.PREVIEW,
    updates: () => ({ selectedAction: 'forward' }),
  }),
  edge({
    from: SessionState.ACTION_SELECT, on: 'ACTION_SELECTED',
    when: e => e.action === 'quick',
    to: () => SessionState.PREVIEW,
    updates: e => ({ selectedAction: 'transform', textHandling: e.isTextOnly ? 'keep' : 'remove', selectedUserId: e.fromUserId ?? null }),
  }),
  // Transform always goes through the merged text-handling + custom-text step; the
  // handling default is what that step preselects (blockquotes must stay intact).
  edge({
    from: SessionState.ACTION_SELECT, on: 'ACTION_SELECTED',
    when: e => e.action === 'transform',
    to: () => SessionState.TEXT_HANDLING,
    updates: e => ({
      selectedAction: 'transform',
      ...(e.knownNicknameUserId != null && { selectedUserId: e.knownNicknameUserId }),
    }),
  }),

  // ── TEXT_HANDLING (text choice) ──────────────────────────────────────────────
  // One step picks the post's text: the original (keep/quote) or a custom one,
  // which replaces it (handling 'remove').
  edge({
    from: SessionState.TEXT_HANDLING, on: 'TEXT_CHOSEN',
    to: e => afterTextCustom(e.knownNicknameUserId),
    updates: e => ({
      textHandling: e.handling,
      customText: e.text,
      ...(e.knownNicknameUserId != null && { selectedUserId: e.knownNicknameUserId }),
    }),
  }),

  // ── NICKNAME_SELECT ──────────────────────────────────────────────────────────
  edge({
    from: SessionState.NICKNAME_SELECT, on: 'NICKNAME_SELECTED',
    to: () => SessionState.PREVIEW,
    updates: e => ({ selectedUserId: e.userId }),
  }),
];

export function transition(state: SessionState, event: FlowEvent): TransitionResult {
  const matched = TRANSITIONS.find(
    t => t.from === state && t.on === event.type && (t.when?.(event) ?? true)
  );
  if (!matched) throw new Error(`No transition: ${state} + ${event.type}`);

  const newState = matched.to(event);
  const step = STEP_BY_STATE[newState];
  if (!step) throw new Error(`No step defined for state: ${newState}`);

  return Object.freeze({
    newState,
    step,
    sessionUpdates: Object.freeze(matched.updates(event)),
  });
}
