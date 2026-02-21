import type { ISession } from '../../database/models/session.model.js';
import type { MessageContent } from '../../types/message.types.js';
import { extractMessageContent } from '../../bot/handlers/forward.handler.js';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { transformerService } from '../../services/transformer.service.js';
import { logger } from '../../utils/logger.js';

/**
 * Generates preview content from session data.
 * For 'forward' action: returns original content unchanged.
 * For 'transform' action: applies text transformations and attribution.
 */
export class PreviewGeneratorService {
  async generatePreview(session: ISession): Promise<MessageContent> {
    logger.debug(`Generating preview for session ${session._id}, action: ${session.selectedAction}`);

    // For reply chains, return placeholder content
    // Actual preview is sent via forwardMessages in PreviewSenderService
    if (session.replyChainMessages && session.replyChainMessages.length > 1) {
      return {
        type: 'text',
        text: `🧵 Thread of ${session.replyChainMessages.length} messages (see above)`,
      };
    }

    const mediaGroupMessages = session.mediaGroupMessages ?? [];
    const content = extractMessageContent(session.originalMessage, mediaGroupMessages);

    if (!content) {
      throw new Error(`Unable to extract message content from session ${session._id}`);
    }

    // For forward action, return the original content unchanged
    if (session.selectedAction === 'forward') {
      logger.debug(`Preview for session ${session._id}: returning original content (forward action)`);
      return content;
    }

    // For transform action, apply text transformations and attribution
    const forwardInfo = parseForwardInfo(session.originalMessage);

    // Reconstruct mediaGroupMessageIds if this is a media group
    if (mediaGroupMessages.length > 1) {
      forwardInfo.mediaGroupMessageIds = mediaGroupMessages.map((msg) => msg.message_id);
    }

    const originalText = content.text ?? '';
    const textHandling = session.textHandling ?? 'keep';

    logger.debug(`Transforming preview text for session ${session._id}`, {
      textHandling,
      selectedNickname: session.selectedNickname,
      hasCustomText: !!session.customText,
    });

    const transformedText = await transformerService.transformMessage(
      originalText,
      forwardInfo,
      'transform',
      textHandling,
      session.selectedNickname,
      session.customText
    );

    return {
      ...content,
      text: transformedText,
    };
  }
}
