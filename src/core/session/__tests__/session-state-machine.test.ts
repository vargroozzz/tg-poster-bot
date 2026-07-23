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
  const base = { hasText: false, hasBlockquotes: false } as const;

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

  it('quick action on text-only message keeps text handling', () => {
    const result = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'quick', ...base, isTextOnly: true, fromUserId: 99,
    });
    expect(result.sessionUpdates).toMatchObject({ selectedAction: 'transform', textHandling: 'keep', selectedUserId: 99 });
  });

  it('transform goes to the merged text/custom-text step', () => {
    const result = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'transform', hasText: true, hasBlockquotes: false,
    });
    expect(result.newState).toBe(SessionState.TEXT_HANDLING);
    expect(result.step).toEqual({ type: 'show_text_handling' });
    expect(result.sessionUpdates).toMatchObject({ selectedAction: 'transform', textHandling: 'remove' });
  });

  it('transform with blockquoted text preselects keep', () => {
    const result = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'transform', hasText: true, hasBlockquotes: true,
    });
    expect(result.newState).toBe(SessionState.TEXT_HANDLING);
    expect(result.sessionUpdates).toMatchObject({ textHandling: 'keep' });
  });

  it('transform with no text preselects keep', () => {
    const result = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'transform', ...base,
    });
    expect(result.sessionUpdates).toMatchObject({ textHandling: 'keep' });
  });

  it('transform with a known nickname records it upfront', () => {
    const result = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'transform', ...base, knownNicknameUserId: 42,
    });
    expect(result.newState).toBe(SessionState.TEXT_HANDLING);
    expect(result.sessionUpdates).toMatchObject({ selectedUserId: 42 });
  });
});

describe('transition — TEXT_HANDLING (merged step)', () => {
  it('stores custom text and goes to nickname select', () => {
    const result = transition(SessionState.TEXT_HANDLING, {
      type: 'CUSTOM_TEXT_SELECTED', text: 'hello',
    });
    expect(result.newState).toBe(SessionState.NICKNAME_SELECT);
    expect(result.step).toEqual({ type: 'show_nickname_select' });
    expect(result.sessionUpdates).toMatchObject({ customText: 'hello' });
  });

  it('skipping custom text still asks for a nickname', () => {
    const result = transition(SessionState.TEXT_HANDLING, { type: 'CUSTOM_TEXT_SELECTED' });
    expect(result.newState).toBe(SessionState.NICKNAME_SELECT);
  });

  it('auto-skips to PREVIEW when the nickname is already known', () => {
    const result = transition(SessionState.TEXT_HANDLING, {
      type: 'CUSTOM_TEXT_SELECTED', text: 'hi', knownNicknameUserId: 7,
    });
    expect(result.newState).toBe(SessionState.PREVIEW);
    expect(result.step).toEqual({ type: 'show_preview' });
    expect(result.sessionUpdates).toMatchObject({ customText: 'hi', selectedUserId: 7 });
  });
});

describe('transition — NICKNAME_SELECT', () => {
  it('goes to PREVIEW', () => {
    const result = transition(SessionState.NICKNAME_SELECT, {
      type: 'NICKNAME_SELECTED', userId: 5,
    });
    expect(result.newState).toBe(SessionState.PREVIEW);
    expect(result.step).toEqual({ type: 'show_preview' });
    expect(result.sessionUpdates).toMatchObject({ selectedUserId: 5 });
  });

  it('stores null for "no attribution"', () => {
    const result = transition(SessionState.NICKNAME_SELECT, {
      type: 'NICKNAME_SELECTED', userId: null,
    });
    expect(result.sessionUpdates).toMatchObject({ selectedUserId: null });
  });
});

describe('transition — full transform path', () => {
  it('action → merged step → nickname → preview', () => {
    const first = transition(SessionState.ACTION_SELECT, {
      type: 'ACTION_SELECTED', action: 'transform', hasText: true, hasBlockquotes: false,
    });
    expect(first.newState).toBe(SessionState.TEXT_HANDLING);

    const second = transition(first.newState, { type: 'CUSTOM_TEXT_SELECTED', text: 'hi' });
    expect(second.newState).toBe(SessionState.NICKNAME_SELECT);

    const third = transition(second.newState, { type: 'NICKNAME_SELECTED', userId: null });
    expect(third.newState).toBe(SessionState.PREVIEW);
  });
});

describe('transition — error cases', () => {
  it('throws when no edge matches', () => {
    expect(() =>
      transition(SessionState.PREVIEW, { type: 'CHANNEL_SELECTED', channelId: 'x', isGreenListed: false, isPoll: false })
    ).toThrow('No transition: preview + CHANNEL_SELECTED');
  });
});
