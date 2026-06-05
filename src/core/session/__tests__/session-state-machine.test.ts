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
