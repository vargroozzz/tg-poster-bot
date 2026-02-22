import type { MessageEntity } from 'grammy/types';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function openTag(entity: MessageEntity): string {
  switch (entity.type) {
    case 'bold':
      return '<b>';
    case 'italic':
      return '<i>';
    case 'underline':
      return '<u>';
    case 'strikethrough':
      return '<s>';
    case 'spoiler':
      return '<tg-spoiler>';
    case 'code':
      return '<code>';
    case 'pre':
      return entity.language ? `<pre><code class="language-${entity.language}">` : '<pre>';
    case 'text_link':
      return `<a href="${entity.url}">`;
    case 'text_mention':
      return `<a href="tg://user?id=${entity.user?.id}">`;
    default:
      return '';
  }
}

function closeTag(entity: MessageEntity): string {
  switch (entity.type) {
    case 'bold':
      return '</b>';
    case 'italic':
      return '</i>';
    case 'underline':
      return '</u>';
    case 'strikethrough':
      return '</s>';
    case 'spoiler':
      return '</tg-spoiler>';
    case 'code':
      return '</code>';
    case 'pre':
      return entity.language ? '</code></pre>' : '</pre>';
    case 'text_link':
      return '</a>';
    case 'text_mention':
      return '</a>';
    default:
      return '';
  }
}

/**
 * Convert a Telegram message text with entities into an HTML string
 * suitable for use with parse_mode: 'HTML'.
 *
 * Telegram entity offsets are UTF-16 code units, matching JavaScript's
 * native string indexing, so substring() works correctly.
 */
export function entitiesToHtml(text: string, entities?: MessageEntity[]): string {
  if (!entities || entities.length === 0) {
    return escapeHtml(text);
  }

  const events: Array<{ pos: number; open: boolean; entity: MessageEntity }> = [];
  for (const entity of entities) {
    events.push({ pos: entity.offset, open: true, entity });
    events.push({ pos: entity.offset + entity.length, open: false, entity });
  }

  // Sort by position; at the same position close tags come before open tags
  events.sort((a, b) => {
    if (a.pos !== b.pos) return a.pos - b.pos;
    return a.open ? 1 : -1;
  });

  let result = '';
  let pos = 0;

  for (const event of events) {
    if (event.pos > pos) {
      result += escapeHtml(text.substring(pos, event.pos));
      pos = event.pos;
    }
    result += event.open ? openTag(event.entity) : closeTag(event.entity);
  }

  if (pos < text.length) {
    result += escapeHtml(text.substring(pos));
  }

  return result;
}
