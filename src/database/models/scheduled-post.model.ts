import mongoose, { Schema, Document } from 'mongoose';
import type { ForwardInfo, MessageContent, TransformAction } from '../../types/message.types.js';

/**
 * Metadata for tracking retry attempts
 */
export interface RetryMetadata {
  attemptCount: number;
  lastAttemptAt?: Date;
  nextRetryAt?: Date;
  lastError?: string;
}

export interface IScheduledPost extends Document {
  scheduledTime: Date;
  targetChannelId: string;
  telegramScheduledMessageId?: number;
  originalForward: ForwardInfo;
  content: MessageContent;
  action: TransformAction;
  status: 'pending' | 'posted' | 'failed';
  postedAt?: Date;
  error?: string;
  retryMetadata?: RetryMetadata;
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
  },
  content: {
    type: {
      type: String,
      enum: ['text', 'photo', 'video', 'document', 'animation', 'media_group'],
      required: true,
    },
    text: String,
    fileId: String,
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
      },
    ],
  },
  action: {
    type: String,
    enum: ['transform', 'forward'],
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'posted', 'failed'],
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
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Compound unique index to prevent double-booking
scheduledPostSchema.index({ scheduledTime: 1, targetChannelId: 1 }, { unique: true });

// TTL index for automatic cleanup after 90 days
scheduledPostSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90 days

export const ScheduledPost = mongoose.model<IScheduledPost>(
  'ScheduledPost',
  scheduledPostSchema
);
