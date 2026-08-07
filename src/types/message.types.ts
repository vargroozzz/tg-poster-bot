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
  type: 'photo' | 'video' | 'document' | 'audio';
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
  hasSpoiler?: boolean;
}

export interface VoiceContent {
  type: 'voice';
  fileId: string;
  text?: string;
}

export interface AudioContent {
  type: 'audio';
  fileId: string;
  text?: string;
}

// Telegram has no caption on these, so `text` is carried (the transform pipeline sets it
// uniformly) but dropped on send — attribution can't be attached to them.
export interface VideoNoteContent {
  type: 'video_note';
  fileId: string;
  text?: string;
}

export interface StickerContent {
  type: 'sticker';
  fileId: string;
  text?: string;
}

export interface DiceContent {
  type: 'dice';
  emoji: string;
  text?: string;
}

export interface ContactContent {
  type: 'contact';
  phoneNumber: string;
  firstName: string;
  lastName?: string;
  vcard?: string;
  text?: string;
}

export interface LocationContent {
  type: 'location';
  latitude: number;
  longitude: number;
  text?: string;
}

export interface VenueContent {
  type: 'venue';
  latitude: number;
  longitude: number;
  title: string;
  address: string;
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
  | VoiceContent
  | AudioContent
  | VideoNoteContent
  | StickerContent
  | DiceContent
  | ContactContent
  | LocationContent
  | VenueContent
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
  // Place the caption above the media rather than below it.
  textAbove?: boolean;
  // Spoiler state per album position (index 0 for a single medium). Undefined means the
  // source message's own flags stand; see core/sending/spoilers.ts.
  spoilers?: boolean[];
  // Whether the preview's per-item spoiler keyboard is open.
  spoilerMenu?: boolean;
  waitingForCustomText?: boolean;
  mediaGroupMessages?: Message[];
  replyChainMessages?: Message[];
}
