export type ChannelLike = {
  channelId: string;
  channelTitle?: string | null;
  channelUsername?: string | null;
};

/** Friendly label for a channel: title, else username, else the raw id. */
export function channelLabel(channel: ChannelLike): string {
  return channel.channelTitle ?? channel.channelUsername ?? channel.channelId;
}
