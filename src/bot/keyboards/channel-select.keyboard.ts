import type { InlineKeyboardMarkup } from 'grammy/types';
import { channelLabel, type ChannelLike } from '../../shared/helpers/channel.helper.js';
import { POST_FLOW, type FlowCallbacks } from './flow-callbacks.js';

export function createChannelSelectKeyboard(
  channels: ChannelLike[],
  cb: FlowCallbacks = POST_FLOW
): InlineKeyboardMarkup {
  return {
    inline_keyboard: channels.map((channel) => [
      { text: channelLabel(channel), callback_data: cb('channel', channel.channelId) },
    ]),
  };
}
