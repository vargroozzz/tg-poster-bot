import { InlineKeyboard } from 'grammy';

interface Channel {
  channelId: string;
  channelTitle?: string | null;
}

export function createQueueChannelSelectKeyboard(channels: Channel[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const channel of channels) {
    const label = channel.channelTitle ?? channel.channelId;
    keyboard.text(label, `queue:ch:${channel.channelId}:1`).row();
  }
  return keyboard;
}
