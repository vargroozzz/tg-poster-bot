import { Context } from 'grammy';
import { parseForwardInfo } from '../../utils/message-parser.js';

export function isValidChannelId(channelId: string): boolean {
  return /^-\d+$/.test(channelId);
}

export async function validateChannelId(
  ctx: Context,
  channelId?: string
): Promise<string | null> {
  if (!channelId || !isValidChannelId(channelId)) {
    await ctx.reply('❌ Invalid channel ID format. It should start with - and be numeric.');
    return null;
  }
  return channelId;
}

export async function extractChannelIdFromReply(
  ctx: Context,
  providedId?: string
): Promise<string | null> {
  if (providedId) return validateChannelId(ctx, providedId);

  const replyToMessage = ctx.message?.reply_to_message;
  if (!replyToMessage) {
    await ctx.reply(
      '❌ Please provide a channel ID or reply to a forwarded message from the channel.'
    );
    return null;
  }

  const forwardInfo = parseForwardInfo(replyToMessage);
  if (forwardInfo?.fromChannelId) return String(forwardInfo.fromChannelId);

  await ctx.reply('❌ The replied message must be forwarded from a channel.');
  return null;
}

export function extractUserId(commandText: string): number | null {
  const parts = commandText.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const userId = parseInt(parts[1], 10);
  return isNaN(userId) ? null : userId;
}

export function extractChannelId(commandText: string): string | null {
  const parts = commandText.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const channelId = parts[1];
  return isValidChannelId(channelId) ? channelId : null;
}
