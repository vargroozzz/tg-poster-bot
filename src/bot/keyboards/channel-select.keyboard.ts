import { InlineKeyboard } from 'grammy';

export interface ChannelInfo {
  id: string;
  title: string;
}

export function createChannelSelectKeyboard(channels: ChannelInfo[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  channels.forEach((channel, index) => {
    keyboard.text(channel.title, `select_channel:${channel.id}`);

    // Add row break after each channel for better readability
    if (index < channels.length - 1) {
      keyboard.row();
    }
  });

  return keyboard;
}
