import mongoose, { Schema, Document } from 'mongoose';

export type ListType = 'green' | 'red';

export interface IChannelList extends Document {
  channelId: string;
  channelUsername?: string;
  channelTitle?: string;
  listType: ListType;
  addedAt: Date;
  notes?: string;
}

const channelListSchema = new Schema<IChannelList>({
  channelId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  channelUsername: String,
  channelTitle: String,
  listType: {
    type: String,
    enum: ['green', 'red'],
    required: true,
  },
  addedAt: {
    type: Date,
    default: Date.now,
  },
  notes: String,
});

export const ChannelList = mongoose.model<IChannelList>('ChannelList', channelListSchema);
