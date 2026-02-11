import { SessionState, type SessionContext } from '../../shared/constants/flow-states.js';

/**
 * State machine for session flow management
 * Determines valid state transitions based on context
 */
export class SessionStateMachine {
  /**
   * Get the next state based on current state and context
   */
  static getNextState(current: SessionState, context: SessionContext): SessionState {
    switch (current) {
      case SessionState.CHANNEL_SELECT:
        // After selecting channel
        if (context.isGreenListed) {
          // Green-listed: skip all options, go directly to completion
          return SessionState.COMPLETED;
        }
        if (context.isRedListed) {
          // Red-listed: skip action selection, go to text handling or nickname
          return context.hasText ? SessionState.TEXT_HANDLING : SessionState.NICKNAME_SELECT;
        }
        // Regular: show action selection
        return SessionState.ACTION_SELECT;

      case SessionState.ACTION_SELECT:
        // After selecting transform/forward
        if (!context.isForward) {
          // Transform selected
          return context.hasText ? SessionState.TEXT_HANDLING : SessionState.NICKNAME_SELECT;
        }
        // Forward selected: skip to completion
        return SessionState.COMPLETED;

      case SessionState.TEXT_HANDLING:
        // After text handling, always show nickname selection for transform
        return SessionState.NICKNAME_SELECT;

      case SessionState.NICKNAME_SELECT:
        // After nickname selection, show custom text option
        return SessionState.CUSTOM_TEXT;

      case SessionState.CUSTOM_TEXT:
        // After custom text decision, we're done
        return SessionState.COMPLETED;

      case SessionState.COMPLETED:
        // Already completed
        return SessionState.COMPLETED;

      default:
        throw new Error(`Unknown state: ${current}`);
    }
  }

  /**
   * Check if a state transition is valid
   */
  static isValidTransition(from: SessionState, to: SessionState, context: SessionContext): boolean {
    const expectedNext = this.getNextState(from, context);
    return expectedNext === to;
  }

  /**
   * Get all possible next states for the current state
   */
  static getPossibleNextStates(current: SessionState): SessionState[] {
    switch (current) {
      case SessionState.CHANNEL_SELECT:
        return [SessionState.ACTION_SELECT, SessionState.TEXT_HANDLING, SessionState.NICKNAME_SELECT, SessionState.COMPLETED];
      case SessionState.ACTION_SELECT:
        return [SessionState.TEXT_HANDLING, SessionState.NICKNAME_SELECT, SessionState.COMPLETED];
      case SessionState.TEXT_HANDLING:
        return [SessionState.NICKNAME_SELECT];
      case SessionState.NICKNAME_SELECT:
        return [SessionState.CUSTOM_TEXT];
      case SessionState.CUSTOM_TEXT:
        return [SessionState.COMPLETED];
      case SessionState.COMPLETED:
        return [];
      default:
        return [];
    }
  }
}
