import mongoose, { Schema, Document } from 'mongoose';
import type { Message } from 'grammy/types';

/**
 * Session model for database-backed flow state management
 * Will replace in-memory pendingForwards Map in Phase 4
 */
export interface ISession extends Document {
  userId: number;
  messageId: number;
  chatId: number;
  state: string;
  originalMessage: Message;
  selectedChannel?: string;
  selectedAction?: 'transform' | 'forward';
  textHandling?: 'keep' | 'remove' | 'quote';
  selectedNickname?: string | null;
  customText?: string;
  waitingForCustomText?: boolean;
  mediaGroupMessages?: Message[];
  previewMessageId?: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

const sessionSchema = new Schema<ISession>({
  userId: {
    type: Number,
    required: true,
    index: true,
  },
  messageId: {
    type: Number,
    required: true,
  },
  chatId: {
    type: Number,
    required: true,
  },
  state: {
    type: String,
    required: true,
  },
  originalMessage: {
    type: Schema.Types.Mixed,
    required: true,
  },
  selectedChannel: String,
  selectedAction: {
    type: String,
    enum: ['transform', 'forward'],
  },
  textHandling: {
    type: String,
    enum: ['keep', 'remove', 'quote'],
  },
  selectedNickname: String,
  customText: String,
  waitingForCustomText: Boolean,
  mediaGroupMessages: [Schema.Types.Mixed],
  previewMessageId: {
    type: Number,
    required: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true,
  },
});

// Compound index for finding sessions by user and message
sessionSchema.index({ userId: 1, messageId: 1 }, { unique: true });

// TTL index for automatic cleanup
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model<ISession>('Session', sessionSchema);
