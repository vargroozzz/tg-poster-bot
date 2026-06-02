import { describe, it, expect } from 'vitest';
import { getNextState, getPossibleNextStates } from '../session-state-machine.js';
import { SessionState } from '../../../shared/constants/flow-states.js';

const base = { isGreenListed: false, isRedListed: false, hasText: false, isForward: false };

describe('session-state-machine — reply states', () => {
  describe('WAITING_FOR_REPLY_CONTENT', () => {
    it('transitions to CHANNEL_SELECT', () => {
      expect(getNextState(SessionState.WAITING_FOR_REPLY_CONTENT, base)).toBe(SessionState.CHANNEL_SELECT);
    });
    it('lists CHANNEL_SELECT as possible next state', () => {
      expect(getPossibleNextStates(SessionState.WAITING_FOR_REPLY_CONTENT)).toContain(SessionState.CHANNEL_SELECT);
    });
  });

  describe('REPLY_SLOT_CHOICE', () => {
    it('transitions to ACTION_SELECT', () => {
      expect(getNextState(SessionState.REPLY_SLOT_CHOICE, base)).toBe(SessionState.ACTION_SELECT);
    });
    it('lists ACTION_SELECT as possible next state', () => {
      expect(getPossibleNextStates(SessionState.REPLY_SLOT_CHOICE)).toContain(SessionState.ACTION_SELECT);
    });
  });
});
