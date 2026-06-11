import type { MessageContent, TextHandling } from '../../types/message.types.js';

export function applyTextHandling(text: string, handling: TextHandling): string {
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

export function prependCustomText(text: string, customText?: string): string {
  if (!customText) return text;
  return customText + (text ? '\n\n' + text : '');
}

export function transformText(
  originalText: string,
  handling: TextHandling,
  customText?: string
): string {
  return prependCustomText(applyTextHandling(originalText, handling), customText);
}

/**
 * A text-only message has no media to carry the post, so it can't end up
 * with empty text - Telegram's sendMessage rejects an empty string. If
 * removing the text (and there's no attribution/custom text to fill in)
 * would leave nothing, fall back to the original text.
 */
export function preventEmptyTextContent(
  contentType: MessageContent['type'],
  originalText: string,
  transformedText: string
): string {
  if (contentType === 'text' && !transformedText.trim() && originalText.trim()) {
    return originalText;
  }
  return transformedText;
}
