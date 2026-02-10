export interface ForwardInfo {
  messageId: number;
  chatId: number;
  fromUserId?: number;
  fromUsername?: string;
  fromChannelId?: number;
  fromChannelUsername?: string;
  fromChannelTitle?: string;
  messageLink?: string;
}

export interface MessageContent {
  type: 'text' | 'photo' | 'video' | 'document' | 'animation';
  text?: string;
  fileId?: string;
  mediaGroup?: string[];
}

export type TransformAction = 'transform' | 'forward';

export type TextHandling = 'keep' | 'remove' | 'quote';
