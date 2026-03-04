import type { TextHandling } from '../../types/message.types.js';

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
