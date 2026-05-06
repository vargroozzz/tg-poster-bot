import mongoose, { Schema, Document } from 'mongoose';
import type { Message } from 'grammy/types';
import type { ForwardInfo, MessageContent, PostSelections } from '../../types/message.types.js';

/**
 * Session model for database-backed flow state management
 * Will replace in-memory pendingForwards Map in Phase 4
 */
export interface ISession extends Document, PostSelections {
  userId: number;
  messageId: number;
  chatId: number;
  state: string;
  originalMessage?: Message;
  previewMessageId?: number;
  previewMessageIds?: number[];
  editingPostId?: string;
  editingOriginalChannelId?: string;
  editingOriginalScheduledTime?: Date;
  editingRawContent?: MessageContent;
  editingOriginalForward?: ForwardInfo;
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
    required: false,
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
  replyChainMessages: [Schema.Types.Mixed],
  previewMessageId: {
    type: Number,
    required: false,
  },
  previewMessageIds: {
    type: [Number],
    default: undefined,
  },
  editingPostId: { type: String },
  editingOriginalChannelId: { type: String },
  editingOriginalScheduledTime: { type: Date },
  editingRawContent: { type: Schema.Types.Mixed },
  editingOriginalForward: { type: Schema.Types.Mixed },
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
