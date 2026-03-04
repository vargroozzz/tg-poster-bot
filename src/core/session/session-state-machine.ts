import { SessionState, type SessionContext } from '../../shared/constants/flow-states.js';

export function getNextState(current: SessionState, context: SessionContext): SessionState {
  switch (current) {
    case SessionState.CHANNEL_SELECT:
      if (context.isGreenListed) return SessionState.COMPLETED;
      if (context.isRedListed) {
        return context.hasText ? SessionState.TEXT_HANDLING : SessionState.NICKNAME_SELECT;
      }
      return SessionState.ACTION_SELECT;

    case SessionState.ACTION_SELECT:
      if (!context.isForward) {
        return context.hasText ? SessionState.TEXT_HANDLING : SessionState.NICKNAME_SELECT;
      }
      return SessionState.COMPLETED;

    case SessionState.TEXT_HANDLING:
      return SessionState.NICKNAME_SELECT;

    case SessionState.NICKNAME_SELECT:
      return SessionState.CUSTOM_TEXT;

    case SessionState.CUSTOM_TEXT:
      return SessionState.PREVIEW;

    case SessionState.PREVIEW:
      return SessionState.COMPLETED;

    case SessionState.COMPLETED:
      return SessionState.COMPLETED;

    default:
      throw new Error(`Unknown state: ${current}`);
  }
}

export function isValidTransition(
  from: SessionState,
  to: SessionState,
  context: SessionContext
): boolean {
  return getNextState(from, context) === to;
}

export function getPossibleNextStates(current: SessionState): SessionState[] {
  switch (current) {
    case SessionState.CHANNEL_SELECT:
      return [
        SessionState.ACTION_SELECT,
        SessionState.TEXT_HANDLING,
        SessionState.NICKNAME_SELECT,
        SessionState.COMPLETED,
      ];
    case SessionState.ACTION_SELECT:
      return [SessionState.TEXT_HANDLING, SessionState.NICKNAME_SELECT, SessionState.COMPLETED];
    case SessionState.TEXT_HANDLING:
      return [SessionState.NICKNAME_SELECT];
    case SessionState.NICKNAME_SELECT:
      return [SessionState.CUSTOM_TEXT];
    case SessionState.CUSTOM_TEXT:
      return [SessionState.PREVIEW];
    case SessionState.PREVIEW:
      return [SessionState.COMPLETED];
    case SessionState.COMPLETED:
      return [];
    default:
      return [];
  }
}
