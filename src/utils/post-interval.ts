import { PostingChannel } from '../database/models/posting-channel.model.js';

export const VALID_INTERVALS = [15, 30, 60] as const;
export type PostInterval = (typeof VALID_INTERVALS)[number];

export async function getPostInterval(channelId?: string): Promise<PostInterval> {
  if (channelId != null) {
    const channel = await PostingChannel.findOne({ channelId }).select('postInterval');
    if (channel?.postInterval != null) {
      const val = channel.postInterval;
      return VALID_INTERVALS.includes(val as PostInterval) ? (val as PostInterval) : 30;
    }
  }
  return 30;
}

/** Write interval for a specific channel. */
export async function setChannelInterval(channelId: string, minutes: PostInterval): Promise<void> {
  await PostingChannel.findOneAndUpdate(
    { channelId },
    { $set: { postInterval: minutes } },
    { new: true }
  );
}

