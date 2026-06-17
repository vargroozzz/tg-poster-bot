import { InlineKeyboard } from 'grammy';
import { channelLabel, type ChannelLike } from '../../shared/helpers/channel.helper.js';

export function createQueueChannelSelectKeyboard(channels: ChannelLike[]): InlineKeyboard {
  return new InlineKeyboard(
    channels.map((channel) => [InlineKeyboard.text(channelLabel(channel), `queue:ch:${channel.channelId}:1`)])
  );
}
