import { InlineKeyboard } from 'grammy';
import { VALID_INTERVALS, type PostInterval } from '../../utils/post-interval.js';

interface Channel {
  channelId: string;
  channelTitle?: string | null;
}

export function createChannelIntervalListKeyboard(channels: Channel[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const channel of channels) {
    const label = channel.channelTitle ?? channel.channelId;
    keyboard.text(label, `interval:ch:${channel.channelId}`).row();
  }
  return keyboard;
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
