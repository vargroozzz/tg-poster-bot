import type { Message } from 'grammy/types';

export interface ForwardInfo {
  messageId: number;
  chatId: number;
  fromUserId?: number;
  fromUsername?: string;
  fromChannelId?: number;
  fromChannelUsername?: string;
  fromChannelTitle?: string;
  messageLink?: string;
  mediaGroupMessageIds?: number[]; // For forwarding entire albums
  replyChainMessageIds?: number[]; // For reply chains
  replyParameters?: { chatId: number; messageId: number }; // For cross-chat reply posting
}

export interface MediaGroupItem {
  type: 'photo' | 'video';
  fileId: string;
  hasSpoiler?: boolean;
}

export interface MessageContent {
  type: 'text' | 'photo' | 'video' | 'document' | 'animation' | 'media_group' | 'poll';
  text?: string;
  fileId?: string;
  hasSpoiler?: boolean;
  mediaGroup?: MediaGroupItem[];
  linkPreviewOptions?: { is_disabled?: boolean };
}

export type TransformAction = 'transform' | 'forward';

export type TextHandling = 'keep' | 'remove' | 'quote';

export interface PostSelections {
  selectedChannel?: string;
  selectedAction?: TransformAction;
  textHandling?: TextHandling;
  selectedNickname?: string | null;
  customText?: string;
  waitingForCustomText?: boolean;
  mediaGroupMessages?: Message[];
  replyChainMessages?: Message[];
}
