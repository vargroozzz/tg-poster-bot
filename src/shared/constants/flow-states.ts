/**
 * Session flow states for the scheduling flow
 * Represents the state machine for message scheduling
 */
export enum SessionState {
  CHANNEL_SELECT = 'channel_select',
  ACTION_SELECT = 'action_select',
  TEXT_HANDLING = 'text_handling',
  NICKNAME_SELECT = 'nickname_select',
  CUSTOM_TEXT = 'custom_text',
  PREVIEW = 'preview',
  COMPLETED = 'completed',
}

/**
 * Context for state transitions
 */
export interface SessionContext {
  isGreenListed: boolean;
  isRedListed: boolean;
  hasText: boolean;
  isForward: boolean;
}
