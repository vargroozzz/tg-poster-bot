import { Message } from 'grammy/types';
import type { ForwardInfo } from '../types/message.types.js';
import { logger } from './logger.js';

/** Extract reply-to parameters from external_reply, if available. */
function extractReplyParameters(message: Message): { chatId: number; messageId: number } | undefined {
  const ext = message.external_reply;
  if (ext?.chat && ext.message_id !== undefined) {
    return { chatId: ext.chat.id, messageId: ext.message_id };
  }
  return undefined;
}

export function parseForwardInfo(message: Message): ForwardInfo {
  const base: ForwardInfo = {
    messageId: message.message_id,
    chatId: message.chat.id,
  };

  // If not a forward, check for external_reply (cross-chat reply, Bot API 7.0).
  // In this case the message was written by the current user and they are quoting
  // a message from another chat.  external_reply.origin identifies the *quoted*
  // entity, NOT the author of the current message, so we must NOT populate
  // fromChannelId / fromUserId here — those would mislead attribution.
  // We only capture replyParameters so the post can be sent as a real reply.
  if (!message.forward_origin) {
    if (message.external_reply) {
      const replyParameters = extractReplyParameters(message);
      return { ...base, ...(replyParameters ? { replyParameters } : {}) };
    }

    logger.debug('Non-forwarded message, using original message info');
    return base;
  }

  const origin = message.forward_origin;

  // For forwarded messages, also capture reply-to context from external_reply
  // so we can post as a real Telegram reply in the target channel.
  const replyParameters = extractReplyParameters(message);

  // Forwarded from a channel
  if (origin.type === 'channel') {
    const channelUsername = 'username' in origin.chat ? origin.chat.username : undefined;
    const result: ForwardInfo = {
      ...base,
      fromChannelId: origin.chat.id,
      fromChannelTitle: origin.chat.title,
      ...(channelUsername ? {
        fromChannelUsername: channelUsername,
        messageLink: `https://t.me/${channelUsername}/${origin.message_id}`,
      } : {}),
      ...(replyParameters ? { replyParameters } : {}),
    };
    logger.debug('Parsed channel forward:', {
      channelId: result.fromChannelId,
      channelTitle: result.fromChannelTitle,
      messageLink: result.messageLink,
    });
    return result;
  }

  // Forwarded from a user
  if (origin.type === 'user') {
    const result: ForwardInfo = {
      ...base,
      fromUserId: origin.sender_user.id,
      ...(origin.sender_user.username ? { fromUsername: origin.sender_user.username } : {}),
      ...(replyParameters ? { replyParameters } : {}),
    };
    logger.debug('Parsed user forward:', {
      userId: result.fromUserId,
      username: result.fromUsername,
    });
    return result;
  }

  // Forwarded from a hidden user — can't get user info
  logger.debug('Parsed hidden user forward');
  return { ...base, ...(replyParameters ? { replyParameters } : {}) };
}
