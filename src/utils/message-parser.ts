import { Message } from 'grammy/types';
import type { ForwardInfo } from '../types/message.types.js';
import { logger } from './logger.js';

export function parseForwardInfo(message: Message): ForwardInfo | null {
  if (!message.forward_origin) {
    return null;
  }

  const forwardInfo: ForwardInfo = {
    messageId: message.message_id,
    chatId: message.chat.id,
  };

  const origin = message.forward_origin;

  // Forwarded from a channel
  if (origin.type === 'channel') {
    forwardInfo.fromChannelId = origin.chat.id;
    forwardInfo.fromChannelTitle = origin.chat.title;

    if ('username' in origin.chat && origin.chat.username) {
      forwardInfo.fromChannelUsername = origin.chat.username;
      forwardInfo.messageLink = `https://t.me/${origin.chat.username}/${origin.message_id}`;
    }

    logger.debug('Parsed channel forward:', {
      channelId: forwardInfo.fromChannelId,
      channelTitle: forwardInfo.fromChannelTitle,
      messageLink: forwardInfo.messageLink,
    });
  }
  // Forwarded from a user
  else if (origin.type === 'user') {
    forwardInfo.fromUserId = origin.sender_user.id;

    if (origin.sender_user.username) {
      forwardInfo.fromUsername = origin.sender_user.username;
    }

    logger.debug('Parsed user forward:', {
      userId: forwardInfo.fromUserId,
      username: forwardInfo.fromUsername,
    });
  }
  // Forwarded from a hidden user
  else if (origin.type === 'hidden_user') {
    // Can't get user info, but we know it's from a user
    logger.debug('Parsed hidden user forward');
  }

  return forwardInfo;
}
