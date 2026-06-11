import type { ForwardInfo, MessageContent, TransformAction, TextHandling } from '../types/message.types.js';
import { transformText, preventEmptyTextContent } from '../core/transformation/text-transformer.js';
import { buildAttribution } from '../core/attribution/attribution.js';
import { ChannelListRepository } from '../database/repositories/channel-list.repository.js';
import { PostingChannel } from '../database/models/posting-channel.model.js';

const channelListRepo = new ChannelListRepository();

/**
 * Facade for message transformation.
 * Coordinates text transformation and attribution.
 */
export async function transformMessage(
  originalText: string,
  forwardInfo: ForwardInfo,
  action: TransformAction,
  textHandling: TextHandling = 'keep',
  manualNickname?: string | null,
  customText?: string
): Promise<string> {
  const processedText = transformText(originalText, textHandling, customText);

  if (action === 'forward') return processedText;

  const attributionText = await buildAttribution(forwardInfo, manualNickname);
  return processedText + (attributionText ?? '');
}

/**
 * Applies transformMessage to a MessageContent's text, guarding against
 * text-only content ending up empty (Telegram rejects empty sendMessage text).
 */
export async function transformContent(
  content: MessageContent,
  forwardInfo: ForwardInfo,
  action: TransformAction,
  textHandling: TextHandling = 'keep',
  manualNickname?: string | null,
  customText?: string
): Promise<MessageContent> {
  const originalText = content.text ?? '';
  const transformedText = await transformMessage(originalText, forwardInfo, action, textHandling, manualNickname, customText);
  return { ...content, text: preventEmptyTextContent(content.type, originalText, transformedText) };
}

export async function shouldAutoForward(forwardInfo: ForwardInfo): Promise<boolean> {
  if (!forwardInfo.fromChannelId) return false;

  const channelId = String(forwardInfo.fromChannelId);
  if (await channelListRepo.isGreenListed(channelId)) return true;

  const adminedChannel = await PostingChannel.findOne({ channelId, isActive: true }).lean();
  return adminedChannel !== null;
}

export async function isRedListed(channelId: string): Promise<boolean> {
  return channelListRepo.isRedListed(channelId);
}

// Keep singleton export for backwards compat with call sites that import `transformerService`
export const transformerService = {
  transformMessage,
  transformContent,
  shouldAutoForward,
  isRedListed,
};
