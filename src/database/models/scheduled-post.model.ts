import mongoose, { Schema, Document } from 'mongoose';
import type { ForwardInfo, MessageContent, TransformAction, TextHandling } from '../../types/message.types.js';

export interface RetryMetadata {
  attemptCount: number;
  lastAttemptAt?: Date;
  nextRetryAt?: Date;
  lastError?: string;
}

export interface EmbeddedReplyData {
  targetChannelId: string;
  content: MessageContent;
  rawContent?: MessageContent;
  action: TransformAction;
  textHandling?: TextHandling;
  selectedUserId?: number | null;
  customText?: string;
  originalForward: ForwardInfo;
}

export interface IScheduledPost extends Document {
  scheduledTime: Date;
  targetChannelId: string;
  telegramScheduledMessageId?: number;
  originalForward: ForwardInfo;
  content: MessageContent;
  action: TransformAction;
  rawContent?: MessageContent;
  textHandling?: TextHandling;
  selectedUserId?: number | null;
  customText?: string;
  status: 'pending' | 'posted' | 'failed' | 'waiting_parent';
  postedAt?: Date;
  error?: string;
  retryMetadata?: RetryMetadata;
  // Together reply — published atomically with this post
  embeddedReply?: EmbeddedReplyData;
  embeddedReplyError?: string;
  // Separated reply — this post is a reply to parentPostId
  parentPostId?: string;
  replyToMessageId?: number;
  replyToChannelId?: string;
  createdAt: Date;
}

const scheduledPostSchema = new Schema<IScheduledPost>({
  scheduledTime: {
    type: Date,
    required: true,
    index: true,
  },
  targetChannelId: {
    type: String,
    required: true,
  },
  telegramScheduledMessageId: {
    type: Number,
  },
  originalForward: {
    messageId: { type: Number, required: true },
    chatId: { type: Number, required: true },
    fromUserId: Number,
    fromUsername: String,
    fromChannelId: Number,
    fromChannelUsername: String,
    fromChannelTitle: String,
    messageLink: String,
    mediaGroupMessageIds: [Number],
    replyChainMessageIds: [Number],
    replyParameters: {
      chatId: Number,
      messageId: Number,
    },
  },
  content: {
    type: {
      type: String,
      enum: ['text', 'photo', 'video', 'document', 'animation', 'media_group', 'poll'],
      required: true,
    },
    text: String,
    fileId: String,
    hasSpoiler: Boolean,
    mediaGroup: [
      {
        type: {
          type: String,
          enum: ['photo', 'video'],
          required: true,
        },
        fileId: {
          type: String,
          required: true,
        },
        hasSpoiler: Boolean,
      },
    ],
    linkPreviewOptions: {
      is_disabled: Boolean,
    },
  },
  action: {
    type: String,
    enum: ['transform', 'forward'],
    required: true,
  },
  rawContent: {
    type: Schema.Types.Mixed,
  },
  textHandling: {
    type: String,
    enum: ['keep', 'remove', 'quote'],
  },
  selectedUserId: {
    type: Number,
    default: null,
  },
  customText: String,
  status: {
    type: String,
    enum: ['pending', 'posted', 'failed', 'waiting_parent'],
    default: 'pending',
    index: true,
  },
  postedAt: {
    type: Date,
  },
  error: {
    type: String,
  },
  retryMetadata: {
    attemptCount: {
      type: Number,
      default: 0,
    },
    lastAttemptAt: Date,
    nextRetryAt: Date,
    lastError: String,
  },
  embeddedReply: {
    type: Schema.Types.Mixed,
  },
  embeddedReplyError: {
    type: String,
  },
  parentPostId: {
    type: String,
    index: true,
    sparse: true,
  },
  replyToMessageId: {
    type: Number,
  },
  replyToChannelId: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Compound unique index to prevent double-booking
scheduledPostSchema.index({ scheduledTime: 1, targetChannelId: 1 }, { unique: true });

// Sparse index for usage-count aggregation in nickname keyboard
scheduledPostSchema.index({ selectedUserId: 1 }, { sparse: true });

export const ScheduledPost = mongoose.model<IScheduledPost>(
  'ScheduledPost',
  scheduledPostSchema
);
