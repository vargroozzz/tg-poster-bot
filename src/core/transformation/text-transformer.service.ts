import type { TextHandling } from '../../types/message.types.js';

/**
 * Service for text transformation operations
 * Handles text handling (keep/remove/quote) and custom text prepending
 */
export class TextTransformerService {
  /**
   * Apply text handling rules to the original text
   */
  applyTextHandling(text: string, handling: TextHandling): string {
    switch (handling) {
      case 'keep':
        return text;
      case 'remove':
        return '';
      case 'quote':
        return text ? `<blockquote>${text}</blockquote>` : '';
      default:
        return text;
    }
  }

  /**
   * Prepend custom text to the message
   */
  prependCustomText(text: string, customText?: string): string {
    if (!customText) {
      return text;
    }

    return customText + (text ? '\n\n' + text : '');
  }

  /**
   * Transform text with both handling and custom text
   */
  transformText(
    originalText: string,
    handling: TextHandling,
    customText?: string
  ): string {
    const handled = this.applyTextHandling(originalText, handling);
    return this.prependCustomText(handled, customText);
  }
}
