import { InlineKeyboard } from 'grammy';
import { VALID_INTERVALS, type PostInterval } from '../../utils/post-interval.js';
import { channelLabel, type ChannelLike } from '../../shared/helpers/channel.helper.js';

export function createChannelIntervalListKeyboard(channels: ChannelLike[]): InlineKeyboard {
  return new InlineKeyboard(
    channels.map((channel) => [InlineKeyboard.text(channelLabel(channel), `interval:ch:${channel.channelId}`)])
  );
}

export function createChannelIntervalPickerKeyboard(
  channelId: string,
  currentInterval: PostInterval
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const minutes of VALID_INTERVALS) {
    const label = currentInterval === minutes ? `✓ ${minutes} min` : `${minutes} min`;
    keyboard.text(label, `interval:set:${channelId}:${minutes}`);
  }
  keyboard
    .row()
    .text(`Reschedule queue to ${currentInterval} min intervals`, `interval:repack:${channelId}`)
    .row()
    .text('← Back', 'interval:back');
  return keyboard;
}
