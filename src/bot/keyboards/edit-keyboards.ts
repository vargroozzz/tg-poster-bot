import type { InlineKeyboardMarkup } from 'grammy/types';
import { listCustomTextPresets } from '../../database/models/custom-text-preset.model.js';
import { NICKNAME_NONE_KEY } from './nickname-select.keyboard.js';
import { channelLabel, type ChannelLike } from '../../shared/helpers/channel.helper.js';

export function createEditChannelSelectKeyboard(
  channels: ChannelLike[],
  sessionId: string
): InlineKeyboardMarkup {
  return {
    inline_keyboard: channels.map((ch) => [
      {
        text: channelLabel(ch),
        callback_data: `queue:edit:ch:${sessionId}:${ch.channelId}`,
      },
    ]),
  };
}

export function createEditForwardActionKeyboard(sessionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '⚡ Quick post', callback_data: `queue:edit:action:${sessionId}:quick`, style: 'primary' }],
      [
        { text: '✨ Transform', callback_data: `queue:edit:action:${sessionId}:transform` },
        { text: '➡️ Forward', callback_data: `queue:edit:action:${sessionId}:forward` },
      ],
    ],
  };
}

export function createEditTextHandlingKeyboard(sessionId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '📝 Keep', callback_data: `queue:edit:text:${sessionId}:keep` },
        { text: '🗑 Remove', callback_data: `queue:edit:text:${sessionId}:remove` },
        { text: '💬 Quote', callback_data: `queue:edit:text:${sessionId}:quote` },
      ],
    ],
  };
}

export function createEditNicknameKeyboard(
  nicknames: Array<{ userId: number; nickname: string }>,
  sessionId: string
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...nicknames.map((n) => [{ text: n.nickname, callback_data: `queue:edit:nickname:${sessionId}:${n.userId}` }]),
      [{ text: 'No attribution', callback_data: `queue:edit:nickname:${sessionId}:${NICKNAME_NONE_KEY}`, style: 'primary' as const }],
    ],
  };
}

export async function createEditCustomTextKeyboard(sessionId: string): Promise<InlineKeyboardMarkup> {
  const presets = await listCustomTextPresets();
  return {
    inline_keyboard: [
      ...presets.map((p) => [{ text: p.label, callback_data: `ec:preset:${sessionId}:${p._id}` }]),
      [
        { text: 'Skip', callback_data: `queue:edit:custom:${sessionId}:skip`, style: 'primary' as const },
        { text: '✍️ Add text', callback_data: `queue:edit:custom:${sessionId}:add` },
      ],
    ],
  };
}
