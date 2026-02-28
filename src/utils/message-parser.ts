import { Message } from 'grammy/types';
import type { ForwardInfo } from '../types/message.types.js';
import { logger } from './logger.js';

export function parseForwardInfo(message: Message): ForwardInfo {
  const base: ForwardInfo = {
    messageId: message.message_id,
    chatId: message.chat.id,
  };

  // If not a forward, return minimal info (original message)
  if (!message.forward_origin) {
    logger.debug('Non-forwarded message, using original message info');
    return base;
  }

  const origin = message.forward_origin;

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
    };
    logger.debug('Parsed user forward:', {
      userId: result.fromUserId,
      username: result.fromUsername,
    });
    return result;
  }

  // Forwarded from a hidden user — can't get user info
  logger.debug('Parsed hidden user forward');
  return base;
}
