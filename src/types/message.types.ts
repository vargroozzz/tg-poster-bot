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

export interface TextContent {
  type: 'text';
  text: string;
  linkPreviewOptions?: { is_disabled?: boolean };
}

export interface PhotoContent {
  type: 'photo';
  fileId: string;
  text?: string;
  hasSpoiler?: boolean;
}

export interface VideoContent {
  type: 'video';
  fileId: string;
  text?: string;
  hasSpoiler?: boolean;
}

export interface DocumentContent {
  type: 'document';
  fileId: string;
  text?: string;
}

export interface AnimationContent {
  type: 'animation';
  fileId: string;
  text?: string;
}

export interface MediaGroupContent {
  type: 'media_group';
  mediaGroup: MediaGroupItem[];
  text?: string;
}

export interface PollContent {
  type: 'poll';
  text?: string;
}

export type MessageContent =
  | TextContent
  | PhotoContent
  | VideoContent
  | DocumentContent
  | AnimationContent
  | MediaGroupContent
  | PollContent;

export type TransformAction = 'transform' | 'forward';

export type TextHandling = 'keep' | 'remove' | 'quote';

export interface PostSelections {
  selectedChannel?: string;
  selectedAction?: TransformAction;
  textHandling?: TextHandling;
  selectedUserId?: number | null;
  customText?: string;
  waitingForCustomText?: boolean;
  mediaGroupMessages?: Message[];
  replyChainMessages?: Message[];
}
