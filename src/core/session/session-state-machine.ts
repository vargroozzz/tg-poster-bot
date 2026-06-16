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
  readonly step: (event: FlowEvent) => FlowStep;
  readonly updates: (event: FlowEvent) => Readonly<Partial<ISession>>;
}

function edge<ET extends FlowEvent['type']>(e: {
  from: SessionState;
  on: ET;
  when?: (event: Extract<FlowEvent, { type: ET }>) => boolean;
  to: (event: Extract<FlowEvent, { type: ET }>) => SessionState;
  step: (event: Extract<FlowEvent, { type: ET }>) => FlowStep;
  updates: (event: Extract<FlowEvent, { type: ET }>) => Readonly<Partial<ISession>>;
}): EdgeDefinition {
  return e as unknown as EdgeDefinition;
}

// Single source of truth for routing once a nickname is known/chosen:
// plain text needs no custom-text prompt, so skip straight to preview.
const afterNickname = (isPlainText: boolean): { to: SessionState; step: FlowStep } =>
  isPlainText
    ? { to: SessionState.PREVIEW, step: { type: 'show_preview' } }
    : { to: SessionState.CUSTOM_TEXT, step: { type: 'show_custom_text' } };

const TRANSITIONS: readonly EdgeDefinition[] = [
  // ── CHANNEL_SELECT ──────────────────────────────────────────────────────────
  edge({
    from: SessionState.CHANNEL_SELECT, on: 'CHANNEL_SELECTED',
    when: e => e.isGreenListed || e.isPoll,
    to: () => SessionState.PREVIEW,
    step: () => ({ type: 'show_preview' }),
    updates: e => ({ selectedChannel: e.channelId, selectedAction: 'forward' }),
  }),
  edge({
    from: SessionState.CHANNEL_SELECT, on: 'CHANNEL_SELECTED',
    to: () => SessionState.ACTION_SELECT,
    step: () => ({ type: 'show_action_select' }),
    updates: e => ({ selectedChannel: e.channelId }),
  }),

  // ── ACTION_SELECT ────────────────────────────────────────────────────────────
  edge({
    from: SessionState.ACTION_SELECT, on: 'ACTION_SELECTED',
    when: e => e.action === 'forward',
    to: () => SessionState.PREVIEW,
    step: () => ({ type: 'show_preview' }),
    updates: () => ({ selectedAction: 'forward' }),
  }),
  edge({
    from: SessionState.ACTION_SELECT, on: 'ACTION_SELECTED',
    when: e => e.action === 'quick',
    to: () => SessionState.PREVIEW,
    step: () => ({ type: 'show_preview' }),
    updates: e => ({ selectedAction: 'transform', textHandling: e.isTextOnly ? 'keep' : 'remove', selectedUserId: e.fromUserId ?? null }),
  }),
  // transform + (no text | blockquotes): known nickname auto-skips, otherwise ask for one.
  edge({
    from: SessionState.ACTION_SELECT, on: 'ACTION_SELECTED',
    when: e => e.action === 'transform' && (!e.hasText || e.hasBlockquotes) && e.knownNicknameUserId != null,
    to: e => afterNickname(e.isPlainText).to,
    step: e => afterNickname(e.isPlainText).step,
    updates: e => ({
      selectedAction: 'transform',
      ...(e.hasBlockquotes && { textHandling: 'keep' }),
      selectedUserId: e.knownNicknameUserId,
    }),
  }),
  edge({
    from: SessionState.ACTION_SELECT, on: 'ACTION_SELECTED',
    when: e => e.action === 'transform' && (!e.hasText || e.hasBlockquotes) && e.knownNicknameUserId == null,
    to: () => SessionState.NICKNAME_SELECT,
    step: () => ({ type: 'show_nickname_select' }),
    updates: e => ({
      selectedAction: 'transform',
      ...(e.hasBlockquotes && { textHandling: 'keep' }),
    }),
  }),
  edge({
    from: SessionState.ACTION_SELECT, on: 'ACTION_SELECTED',
    when: e => e.action === 'transform' && e.hasText && !e.hasBlockquotes,
    to: () => SessionState.TEXT_HANDLING,
    step: () => ({ type: 'show_text_handling' }),
    updates: () => ({ selectedAction: 'transform' }),
  }),

  // ── TEXT_HANDLING ────────────────────────────────────────────────────────────
  edge({
    from: SessionState.TEXT_HANDLING, on: 'TEXT_HANDLING_SELECTED',
    when: e => e.knownNicknameUserId != null,
    to: e => afterNickname(e.isPlainText).to,
    step: e => afterNickname(e.isPlainText).step,
    updates: e => ({ textHandling: e.handling, selectedUserId: e.knownNicknameUserId }),
  }),
  edge({
    from: SessionState.TEXT_HANDLING, on: 'TEXT_HANDLING_SELECTED',
    when: e => e.knownNicknameUserId == null,
    to: () => SessionState.NICKNAME_SELECT,
    step: () => ({ type: 'show_nickname_select' }),
    updates: e => ({ textHandling: e.handling }),
  }),

  // ── NICKNAME_SELECT ──────────────────────────────────────────────────────────
  edge({
    from: SessionState.NICKNAME_SELECT, on: 'NICKNAME_SELECTED',
    to: e => afterNickname(e.isPlainText).to,
    step: e => afterNickname(e.isPlainText).step,
    updates: e => ({ selectedUserId: e.userId }),
  }),

  // ── CUSTOM_TEXT ──────────────────────────────────────────────────────────────
  edge({
    from: SessionState.CUSTOM_TEXT, on: 'CUSTOM_TEXT_SELECTED',
    to: () => SessionState.PREVIEW,
    step: () => ({ type: 'show_preview' }),
    updates: e => ({ customText: e.text }),
  }),
];

export function transition(state: SessionState, event: FlowEvent): TransitionResult {
  const matched = TRANSITIONS.find(
    t => t.from === state && t.on === event.type && (t.when?.(event) ?? true)
  );
  if (!matched) throw new Error(`No transition: ${state} + ${event.type}`);
  return Object.freeze({
    newState: matched.to(event),
    step: matched.step(event),
    sessionUpdates: Object.freeze(matched.updates(event)),
  });
}
