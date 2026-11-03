import type { InputRichBlock, RichBlock, RichText } from 'grammy/types';
import type { MediaGroupItem } from '../../types/message.types.js';

type OutRichBlock = InputRichBlock;
type DateTimeFormat = Extract<RichText, { type: 'date_time' }>['date_time_format'];

const largest = <T>(sizes: T[]): T => sizes[sizes.length - 1];

// A bot can't post custom emoji to a channel without a Fragment username: keep the fallback emoji.
const withoutCustomEmoji = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(withoutCustomEmoji)
    : v !== null && typeof v === 'object'
      ? 'type' in v && v.type === 'custom_emoji' && 'alternative_text' in v
        ? v.alternative_text
        : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutCustomEmoji(x)]))
      : v;

/**
 * Turn a received rich message's blocks into blocks that can be sent again. They mirror each
 * other, except media carry a file object where sending wants an InputMedia, and list items
 * carry a computed label.
 */
export const toInputRichBlocks = (blocks: RichBlock[]): OutRichBlock[] =>
  withoutCustomEmoji(convert(blocks)) as OutRichBlock[];

function convert(blocks: RichBlock[]): OutRichBlock[] {
  return blocks.flatMap((block): OutRichBlock[] => {
    switch (block.type) {
      case 'list':
        return [{ ...block, items: block.items.map(({ label: _label, blocks: inner, ...item }) => ({ ...item, blocks: convert(inner) })) }];
      case 'blockquote':
      case 'collage':
      case 'slideshow':
      case 'details':
        return [{ ...block, blocks: convert(block.blocks) }];
      case 'photo': {
        const { photo, has_spoiler, ...rest } = block;
        return [{ ...rest, photo: { type: 'photo', media: largest(photo).file_id, has_spoiler } }];
      }
      case 'video': {
        const { video, has_spoiler, ...rest } = block;
        return [{ ...rest, video: { type: 'video', media: video.file_id, has_spoiler } }];
      }
      case 'animation': {
        const { animation, has_spoiler, ...rest } = block;
        return [{ ...rest, animation: { type: 'animation', media: animation.file_id, has_spoiler } }];
      }
      case 'audio':
        return [{ ...block, audio: { type: 'audio', media: block.audio.file_id } }];
      case 'document':
        return [{ ...block, document: { type: 'document', media: block.document.file_id } }];
      case 'voice_note':
        return [{ ...block, voice_note: { type: 'voice_note', media: block.voice_note.file_id } }];
      // Only streamed drafts carry it; a received message never does.
      case 'thinking':
        return [];
      default:
        return [block];
    }
  });
}

/** A media item as a rich block (the photo/video/animation kinds that can sit in a collage). */
export function mediaBlock(item: { type: string; fileId: string; hasSpoiler?: boolean }): OutRichBlock {
  const has_spoiler = item.hasSpoiler ? true : undefined;
  switch (item.type) {
    case 'video':
      return { type: 'video', video: { type: 'video', media: item.fileId, has_spoiler } };
    case 'animation':
      return { type: 'animation', animation: { type: 'animation', media: item.fileId, has_spoiler } };
    default:
      return { type: 'photo', photo: { type: 'photo', media: item.fileId, has_spoiler } };
  }
}

/** An album as one collage block. */
export const collageBlock = (items: MediaGroupItem[]): OutRichBlock => ({
  type: 'collage',
  blocks: items.map(mediaBlock),
});

// --- HTML (the parse_mode subset this bot produces) → rich blocks ---

/** A child is inline text, or a finished block wrapped so it can't be mistaken for text. */
type Child = RichText | { block: OutRichBlock };

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Child[];
}

const isBlock = (c: Child): c is { block: OutRichBlock } => typeof c === 'object' && !Array.isArray(c) && 'block' in c;

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([\da-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

const parseAttrs = (raw: string): Record<string, string> =>
  Object.fromEntries([...raw.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)].map(([, k, v]) => [k, decode(v ?? '')]));

const asText = (parts: RichText[]): RichText => (parts.length === 1 ? parts[0] : parts);

const plain = (t: RichText): string =>
  typeof t === 'string' ? t : Array.isArray(t) ? t.map(plain).join('') : 'text' in t ? plain(t.text) : '';

const isDateTimeFormat = (f: string): f is DateTimeFormat => /^(r|w?[dD]?[tT]?)$/.test(f);

const MENTION = /^tg:\/\/user\?id=(\d+)$/;

function inline(node: Node, text: RichText): RichText {
  switch (node.tag) {
    case 'b':
    case 'strong':
      return { type: 'bold', text };
    case 'i':
    case 'em':
      return { type: 'italic', text };
    case 'u':
    case 'ins':
      return { type: 'underline', text };
    case 's':
    case 'strike':
    case 'del':
      return { type: 'strikethrough', text };
    case 'tg-spoiler':
      return { type: 'spoiler', text };
    case 'span':
      return node.attrs.class === 'tg-spoiler' ? { type: 'spoiler', text } : text;
    case 'code':
      return { type: 'code', text };
    case 'a': {
      const href = node.attrs.href;
      const mention = MENTION.exec(href ?? '');
      // Only the id matters for a mention; the name is what the text already shows.
      if (mention) return { type: 'text_mention', text, user: { id: Number(mention[1]), is_bot: false, first_name: plain(text) } };
      return href ? { type: 'url', text, url: href } : text;
    }
    case 'tg-time': {
      const unix = Number(node.attrs.unix);
      const format = node.attrs.format ?? '';
      return node.attrs.unix && Number.isFinite(unix) && isDateTimeFormat(format)
        ? { type: 'date_time', text, unix_time: unix, date_time_format: format }
        : text;
    }
    // Unknown or unsendable (tg-emoji: a bot can't post custom emoji to a channel): keep the text.
    default:
      return text;
  }
}

/** Inline runs between blocks become paragraphs, without the newlines that separated them. */
function toBlocks(children: Child[]): OutRichBlock[] {
  const groups = children.reduce<Array<RichText[] | OutRichBlock>>((acc, child) => {
    const last = acc[acc.length - 1];
    if (isBlock(child)) return [...acc, child.block];
    return Array.isArray(last) ? [...acc.slice(0, -1), [...last, child]] : [...acc, [child]];
  }, []);

  return groups.flatMap((group): OutRichBlock[] => {
    if (!Array.isArray(group)) return [group];
    const parts = group
      .map((p, i) => (typeof p !== 'string' ? p : p.replace(i === 0 ? /^\n+/ : /^/, '').replace(i === group.length - 1 ? /\n+$/ : /$/, '')))
      .filter((p) => p !== '');
    return plain(parts).trim() ? [{ type: 'paragraph', text: asText(parts) }] : [];
  });
}

function close(node: Node, parentTag: string): Child {
  const text = asText(node.children.filter((c): c is RichText => !isBlock(c)));
  switch (node.tag) {
    case 'pre':
      return { block: { type: 'pre', text: plain(text), ...(node.attrs.language ? { language: node.attrs.language } : {}) } };
    case 'blockquote':
      return {
        block:
          'expandable' in node.attrs
            ? { type: 'expandable_blockquote', text }
            : { type: 'blockquote', blocks: toBlocks(node.children) },
      };
    case 'code':
      // <pre><code>: the pre block already is the code.
      return parentTag === 'pre' ? plain(text) : inline(node, text);
    default:
      return inline(node, text);
  }
}

/**
 * Turn parse_mode HTML, as entitiesToHtml and the attribution builder write it, into rich
 * blocks: blockquotes and pre become their own blocks, the text between them paragraphs.
 * Newlines stay inside the text, where rich text renders them as line breaks.
 */
export function htmlToRichBlocks(html: string): OutRichBlock[] {
  // Move the language from <pre><code class="language-x"> onto the pre that becomes the block.
  const source = html.replace(/<pre><code class="language-([\w+#-]+)">/g, '<pre language="$1"><code>');
  const root: Node = { tag: '', attrs: {}, children: [] };
  // A parse stack is inherently mutable; it never leaves this function.
  const stack: Node[] = [root];
  const top = () => stack[stack.length - 1];
  const pop = () => {
    const node = stack.pop() as Node;
    top().children.push(close(node, top().tag));
  };

  for (const [, closing, rawTag, attrs, text] of source.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)\/?>|([^<]+|<)/g)) {
    const tag = rawTag?.toLowerCase();
    if (text !== undefined) top().children.push(decode(text));
    else if (tag === 'br') top().children.push('\n');
    else if (!closing) stack.push({ tag, attrs: parseAttrs(attrs), children: [] });
    else {
      // Overlapping entities close out of order (<b>a<i>b</b>c</i>): close what's inside the
      // matching tag, then reopen it so the rest keeps its formatting.
      const at = stack.findLastIndex((n) => n.tag === tag);
      if (at < 1) continue;
      const reopen = stack.slice(at + 1).map(({ tag: t, attrs: a }) => ({ tag: t, attrs: a, children: [] }));
      while (stack.length > at) pop();
      stack.push(...reopen);
    }
  }
  // Unclosed tags (a hand-written preset can have them): close what's open.
  while (stack.length > 1) pop();
  return toBlocks(root.children);
}
