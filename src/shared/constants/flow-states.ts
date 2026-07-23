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
      isTextOnly?: boolean;
      fromUserId?: number;
      knownNicknameUserId?: number;
    }>
  | Readonly<{ type: 'NICKNAME_SELECTED'; userId: number | null }>
  | Readonly<{
      type: 'TEXT_CHOSEN';
      handling: 'keep' | 'remove' | 'quote';
      text?: string;
      knownNicknameUserId?: number;
    }>

export type FlowStep =
  | Readonly<{ type: 'show_action_select' }>
  | Readonly<{ type: 'show_text_handling' }>
  | Readonly<{ type: 'show_nickname_select' }>
  | Readonly<{ type: 'show_preview' }>
