import { listCustomTextPresets } from '../../database/models/custom-text-preset.model.js';

interface Channel {
  channelId: string;
  channelTitle?: string | null;
}

export function createEditChannelSelectKeyboard(
  channels: Channel[],
  sessionId: string
): object {
  const rows = channels.map((ch) => [
    {
      text: ch.channelTitle ?? ch.channelId,
      callback_data: `queue:edit:ch:${sessionId}:${ch.channelId}`,
    },
  ]);
  return { inline_keyboard: rows };
}

export function createEditForwardActionKeyboard(sessionId: string): object {
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

export function createEditTextHandlingKeyboard(sessionId: string): object {
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
): object {
  const rows: object[][] = [
    [{ text: 'No attribution', callback_data: `queue:edit:nickname:${sessionId}:none`, style: 'primary' }],
  ];
  nicknames.forEach((n) => {
    rows.push([{ text: n.nickname, callback_data: `queue:edit:nickname:${sessionId}:${n.userId}` }]);
  });
  return { inline_keyboard: rows };
}

export async function createEditCustomTextKeyboard(sessionId: string): Promise<object> {
  const presets = await listCustomTextPresets();
  const rows: object[][] = presets.map((p) => [
    { text: p.label, callback_data: `queue:edit:custom:preset:${sessionId}:${p._id}` },
  ]);
  rows.push([
    { text: 'Skip', callback_data: `queue:edit:custom:${sessionId}:skip`, style: 'primary' },
    { text: '✍️ Add text', callback_data: `queue:edit:custom:${sessionId}:add` },
  ]);
  return { inline_keyboard: rows };
}
