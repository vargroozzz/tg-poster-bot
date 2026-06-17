import type { ChannelInfo } from '../../bot/keyboards/channel-select.keyboard.js';

export type ChannelLike = {
  channelId: string;
  channelTitle?: string | null;
  channelUsername?: string | null;
};

/** Friendly label for a channel: title, else username, else the raw id. */
export function channelLabel(channel: ChannelLike): string {
  return channel.channelTitle ?? channel.channelUsername ?? channel.channelId;
}

/** Map a stored channel doc to the {id, title, username} shape the keyboards expect. */
export function toChannelInfo(channel: ChannelLike): ChannelInfo {
  return {
    id: channel.channelId,
    title: channelLabel(channel),
    username: channel.channelUsername ?? undefined,
  };
}
