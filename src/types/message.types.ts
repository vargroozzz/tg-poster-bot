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
}

export interface MediaGroupItem {
  type: 'photo' | 'video';
  fileId: string;
}

export interface MessageContent {
  type: 'text' | 'photo' | 'video' | 'document' | 'animation' | 'media_group';
  text?: string;
  fileId?: string;
  mediaGroup?: MediaGroupItem[];
}

export type TransformAction = 'transform' | 'forward';

export type TextHandling = 'keep' | 'remove' | 'quote';
