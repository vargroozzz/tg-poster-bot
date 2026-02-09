import mongoose, { Schema, Document } from 'mongoose';

export interface IPostingChannel extends Document {
  channelId: string;
  channelUsername?: string;
  channelTitle?: string;
  addedAt: Date;
  isActive: boolean;
}

const postingChannelSchema = new Schema<IPostingChannel>({
  channelId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  channelUsername: String,
  channelTitle: String,
  addedAt: {
    type: Date,
    default: Date.now,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
});

export const PostingChannel = mongoose.model<IPostingChannel>(
  'PostingChannel',
  postingChannelSchema
);

// Helper functions
export async function getActivePostingChannels() {
  return await PostingChannel.find({ isActive: true }).sort({ channelTitle: 1, addedAt: -1 });
}

export async function addPostingChannel(
  channelId: string,
  channelUsername?: string,
  channelTitle?: string
): Promise<IPostingChannel> {
  return await PostingChannel.findOneAndUpdate(
    { channelId },
    {
      channelId,
      channelUsername,
      channelTitle,
      isActive: true,
      addedAt: new Date(),
    },
    { upsert: true, new: true }
  );
}

export async function removePostingChannel(channelId: string): Promise<boolean> {
  const result = await PostingChannel.deleteOne({ channelId });
  return result.deletedCount > 0;
}
