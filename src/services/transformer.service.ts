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
/** The post's text and, separately, the attribution line appended to it (when there is one). */
async function transformParts(
  originalText: string,
  forwardInfo: ForwardInfo,
  action: TransformAction,
  textHandling: TextHandling,
  manualNickname?: string | null,
  customText?: string
): Promise<{ text: string; attribution?: string }> {
  const processedText = transformText(originalText, textHandling, customText);

  if (action === 'forward') return { text: processedText };

  const attribution = (await buildAttribution(forwardInfo, manualNickname)) ?? undefined;
  return { text: processedText + (attribution ?? ''), attribution };
}

/**
 * Applies the transform to a MessageContent's text, guarding against text-only content
 * ending up empty (Telegram rejects empty sendMessage text). The attribution is also kept
 * on its own, so a send can place it apart from the text.
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
  const { text, attribution } = await transformParts(originalText, forwardInfo, action, textHandling, manualNickname, customText);
  const finalText = preventEmptyTextContent(content.type, originalText, text);
  // A text post that fell back to its original no longer ends with the attribution.
  return { ...content, text: finalText, attribution: finalText === text ? attribution : undefined };
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
  transformContent,
  shouldAutoForward,
  isRedListed,
};
