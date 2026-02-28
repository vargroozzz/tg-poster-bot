import type { ForwardInfo, TransformAction, TextHandling } from '../types/message.types.js';
import { TextTransformerService } from '../core/transformation/text-transformer.service.js';
import { NicknameResolverService } from '../core/attribution/nickname-resolver.service.js';
import { AttributionService } from '../core/attribution/attribution.service.js';
import { ChannelListRepository } from '../database/repositories/channel-list.repository.js';

/**
 * Facade service for message transformation
 * Coordinates text transformation and attribution services
 * Maintains backward compatibility while delegating to specialized services
 */
export class TransformerService {
  private textTransformer: TextTransformerService;
  private attribution: AttributionService;
  private channelListRepo: ChannelListRepository;

  constructor() {
    this.textTransformer = new TextTransformerService();
    const nicknameResolver = new NicknameResolverService();
    this.channelListRepo = new ChannelListRepository();
    this.attribution = new AttributionService(nicknameResolver, this.channelListRepo);
  }
  /**
   * Transform message text with attribution based on forward info and action
   * @param manualNickname - Manually selected nickname (overrides automatic lookup). null = no attribution, undefined = use automatic lookup
   * @param customText - Optional custom text to prepend to the message
   */
  async transformMessage(
    originalText: string,
    forwardInfo: ForwardInfo,
    action: TransformAction,
    textHandling: TextHandling = 'keep',
    manualNickname?: string | null,
    customText?: string
  ): Promise<string> {
    // Apply text transformations (quote/remove/keep) and custom text
    const processedText = this.textTransformer.transformText(
      originalText,
      textHandling,
      customText
    );

    // If action is 'forward', return processed text without attribution
    if (action === 'forward') {
      return processedText;
    }

    // Build attribution string based on forward info and rules
    const attributionText = await this.attribution.buildAttribution(
      forwardInfo,
      manualNickname
    );

    return processedText + (attributionText ?? '');
  }

  /**
   * Check if a channel forward should be auto-forwarded (green-listed)
   */
  async shouldAutoForward(forwardInfo: ForwardInfo): Promise<boolean> {
    if (!forwardInfo.fromChannelId) {
      return false;
    }

    const channelId = String(forwardInfo.fromChannelId);
    return await this.channelListRepo.isGreenListed(channelId);
  }

  /**
   * Check if a channel is red-listed (should omit channel reference)
   */
  async isRedListed(channelId: string): Promise<boolean> {
    return await this.channelListRepo.isRedListed(channelId);
  }
}

export const transformerService = new TransformerService();
