import { InlineKeyboard } from 'grammy';
import { listCustomTextPresets } from '../../database/models/custom-text-preset.model.js';
import { NICKNAME_NONE_KEY } from './nickname-select.keyboard.js';

interface Channel {
  channelId: string;
  channelTitle?: string | null;
}

export function createEditChannelSelectKeyboard(
  channels: Channel[],
  sessionId: string
): InlineKeyboard {
  const rows = channels.map((ch) => [
    {
      text: ch.channelTitle ?? ch.channelId,
      callback_data: `queue:edit:ch:${sessionId}:${ch.channelId}`,
    },
  ]);
  return { inline_keyboard: rows } as unknown as InlineKeyboard;
}

export function createEditForwardActionKeyboard(sessionId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: '⚡ Quick post', callback_data: `queue:edit:action:${sessionId}:quick`, style: 'primary' }],
      [
        { text: '✨ Transform', callback_data: `queue:edit:action:${sessionId}:transform` },
        { text: '➡️ Forward', callback_data: `queue:edit:action:${sessionId}:forward` },
      ],
    ],
  } as unknown as InlineKeyboard;
}

export function createEditTextHandlingKeyboard(sessionId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '📝 Keep', callback_data: `queue:edit:text:${sessionId}:keep` },
        { text: '🗑 Remove', callback_data: `queue:edit:text:${sessionId}:remove` },
        { text: '💬 Quote', callback_data: `queue:edit:text:${sessionId}:quote` },
      ],
    ],
  } as unknown as InlineKeyboard;
}

export function createEditNicknameKeyboard(
  nicknames: Array<{ userId: number; nickname: string }>,
  sessionId: string
): InlineKeyboard {
  return {
    inline_keyboard: [
      ...nicknames.map((n) => [{ text: n.nickname, callback_data: `queue:edit:nickname:${sessionId}:${n.userId}` }]),
      [{ text: 'No attribution', callback_data: `queue:edit:nickname:${sessionId}:${NICKNAME_NONE_KEY}`, style: 'primary' }],
    ],
  } as unknown as InlineKeyboard;
}

export async function createEditCustomTextKeyboard(sessionId: string): Promise<InlineKeyboard> {
  const presets = await listCustomTextPresets();
  type Btn = { text: string; callback_data: string; style?: string };
  const rows: Btn[][] = presets.map((p) => [
    { text: p.label, callback_data: `ec:preset:${sessionId}:${p._id}` },
  ]);
  rows.push([
    { text: 'Skip', callback_data: `queue:edit:custom:${sessionId}:skip`, style: 'primary' },
    { text: '✍️ Add text', callback_data: `queue:edit:custom:${sessionId}:add` },
  ]);
  return { inline_keyboard: rows } as unknown as InlineKeyboard;
}
