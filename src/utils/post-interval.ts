import { BotSettings } from '../database/models/bot-settings.model.js';
import { PostingChannel } from '../database/models/posting-channel.model.js';

export const VALID_INTERVALS = [15, 30, 60] as const;
export type PostInterval = (typeof VALID_INTERVALS)[number];

/**
 * Read post interval for a channel. Falls back to global BotSettings key,
 * then to 30 if neither is set.
 */
export async function getPostInterval(channelId?: string): Promise<PostInterval> {
  if (channelId != null) {
    const channel = await PostingChannel.findOne({ channelId }).select('postInterval');
    if (channel?.postInterval != null) {
      const val = channel.postInterval;
      return VALID_INTERVALS.includes(val as PostInterval) ? (val as PostInterval) : 30;
    }
  }
  const setting = await BotSettings.findOne({ key: 'post_interval' });
  const parsed = parseInt(setting?.value ?? '30', 10);
  return VALID_INTERVALS.includes(parsed as PostInterval) ? (parsed as PostInterval) : 30;
}

/** Write interval for a specific channel. */
export async function setChannelInterval(channelId: string, minutes: PostInterval): Promise<void> {
  await PostingChannel.findOneAndUpdate(
    { channelId },
    { $set: { postInterval: minutes } },
    { new: true }
  );
}

/** Legacy: writes to global BotSettings key. Kept for backwards compatibility. */
export async function setPostInterval(minutes: PostInterval): Promise<void> {
  await BotSettings.findOneAndUpdate(
    { key: 'post_interval' },
    { key: 'post_interval', value: String(minutes), updatedAt: new Date() },
    { upsert: true, new: true }
  );
}
