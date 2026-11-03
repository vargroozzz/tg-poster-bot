import { describe, it, expect, vi } from 'vitest';
import type { Api } from 'grammy';
import type { RichBlock } from 'grammy/types';
import { htmlToRichBlocks, toInputRichBlocks } from '../rich.js';
import { MediaSenderService, richBlocksFor, sendsAsRich } from '../media-sender.service.js';

const VIA = '\n\nvia <a href="https://t.me/src/5">src</a>';
const viaBlock = { type: 'paragraph', text: ['via ', { type: 'url', text: 'src', url: 'https://t.me/src/5' }] };

describe('htmlToRichBlocks', () => {
  it('makes one paragraph of inline formatting, newlines kept inside', () => {
    expect(htmlToRichBlocks('<b>Hi</b> &amp; <i>there</i>\nnext')).toEqual([
      {
        type: 'paragraph',
        text: [{ type: 'bold', text: 'Hi' }, ' & ', { type: 'italic', text: 'there' }, '\nnext'],
      },
    ]);
  });

  it('splits blockquotes and pre blocks out of the surrounding text', () => {
    expect(
      htmlToRichBlocks(
        'intro\n<blockquote>q</blockquote>\n<blockquote expandable>long</blockquote><pre><code class="language-ts">a &lt; b</code></pre>outro'
      )
    ).toEqual([
      { type: 'paragraph', text: 'intro' },
      { type: 'blockquote', blocks: [{ type: 'paragraph', text: 'q' }] },
      { type: 'expandable_blockquote', text: 'long' },
      { type: 'pre', text: 'a < b', language: 'ts' },
      { type: 'paragraph', text: 'outro' },
    ]);
  });

  it('keeps the attribution line as its own paragraph and a tg-time as a date_time', () => {
    expect(htmlToRichBlocks(VIA)).toEqual([viaBlock]);
    expect(htmlToRichBlocks('<tg-time unix="1647531900" format="wDT">22:45</tg-time>')).toEqual([
      { type: 'paragraph', text: { type: 'date_time', text: '22:45', unix_time: 1647531900, date_time_format: 'wDT' } },
    ]);
  });

  it('survives unknown and unclosed tags, and yields nothing for blank input', () => {
    expect(htmlToRichBlocks('<tg-emoji emoji-id="1">👍</tg-emoji> <b>open')).toEqual([
      { type: 'paragraph', text: ['👍', ' ', { type: 'bold', text: 'open' }] },
    ]);
    expect(htmlToRichBlocks('\n\n')).toEqual([]);
  });

  it('reopens formatting that overlapping entities close out of order', () => {
    expect(htmlToRichBlocks('<b>Hello <i>wo</b>rld</i> more')).toEqual([
      {
        type: 'paragraph',
        text: [
          { type: 'bold', text: ['Hello ', { type: 'italic', text: 'wo' }] },
          { type: 'italic', text: 'rld' },
          ' more',
        ],
      },
    ]);
    expect(htmlToRichBlocks('<blockquote>q <b>x</blockquote> y</b> z')).toEqual([
      { type: 'blockquote', blocks: [{ type: 'paragraph', text: ['q ', { type: 'bold', text: 'x' }] }] },
      { type: 'paragraph', text: [{ type: 'bold', text: ' y' }, ' z'] },
    ]);
  });

  it('reads what parse_mode HTML also accepts: hex entities, span spoilers, a bare <, mentions', () => {
    expect(htmlToRichBlocks('a&#x2014;b <span class="tg-spoiler">s</span> <3')).toEqual([
      { type: 'paragraph', text: ['a\u2014b ', { type: 'spoiler', text: 's' }, ' ', '<', '3'] },
    ]);
    expect(htmlToRichBlocks('<a href="tg://user?id=7">Ann</a>')).toEqual([
      { type: 'paragraph', text: { type: 'text_mention', text: 'Ann', user: { id: 7, is_bot: false, first_name: 'Ann' } } },
    ]);
  });

  it('drops a tg-time with a format Telegram would reject, keeping its text', () => {
    expect(htmlToRichBlocks('<tg-time unix="1" format="xyz">t</tg-time>')).toEqual([{ type: 'paragraph', text: 't' }]);
  });
});

describe('toInputRichBlocks', () => {
  it('swaps media objects for file ids, drops list labels and draft-only blocks, recursing', () => {
    const received = [
      {
        type: 'blockquote',
        blocks: [{ type: 'photo', photo: [{ file_id: 'small' }, { file_id: 'big' }], has_spoiler: true }],
      },
      { type: 'list', items: [{ label: '1.', blocks: [{ type: 'paragraph', text: 'item' }] }] },
      { type: 'video', video: { file_id: 'v' }, caption: { text: 'cap' } },
      { type: 'thinking', text: 'hmm' },
    ] as unknown as RichBlock[];

    expect(toInputRichBlocks(received)).toEqual([
      {
        type: 'blockquote',
        blocks: [{ type: 'photo', photo: { type: 'photo', media: 'big', has_spoiler: true } }],
      },
      { type: 'list', items: [{ blocks: [{ type: 'paragraph', text: 'item' }] }] },
      { type: 'video', video: { type: 'video', media: 'v', has_spoiler: undefined }, caption: { text: 'cap' } },
    ]);
  });

  it('replaces custom emoji, at any depth, with their fallback emoji', () => {
    const received = [
      { type: 'paragraph', text: ['hi ', { type: 'bold', text: { type: 'custom_emoji', custom_emoji_id: '1', alternative_text: '👍' } }] },
    ] as unknown as RichBlock[];
    expect(toInputRichBlocks(received)).toEqual([{ type: 'paragraph', text: ['hi ', { type: 'bold', text: '👍' }] }]);
  });
});

describe('rich layout', () => {
  const photo = { type: 'photo' as const, fileId: 'f1', text: `Body${VIA}`, attribution: VIA };

  it('goes rich only for text above with an attribution, or for a rich source', () => {
    expect(sendsAsRich(photo, true)).toBe(true);
    expect(sendsAsRich(photo, false)).toBe(false);
    expect(sendsAsRich({ ...photo, attribution: undefined }, true)).toBe(false);
    expect(sendsAsRich({ type: 'document', fileId: 'd', text: `x${VIA}`, attribution: VIA }, true)).toBe(false);
    expect(sendsAsRich({ type: 'rich', blocks: [] })).toBe(true);
  });

  it('puts the text above the media and the attribution under it', () => {
    expect(richBlocksFor(photo)).toEqual([
      { type: 'paragraph', text: 'Body' },
      { type: 'photo', photo: { type: 'photo', media: 'f1', has_spoiler: undefined } },
      viaBlock,
    ]);
  });

  it('lays an album out as a collage', () => {
    const album = {
      type: 'media_group' as const,
      text: `Body${VIA}`,
      attribution: VIA,
      mediaGroup: [
        { type: 'photo' as const, fileId: 'a', hasSpoiler: true },
        { type: 'video' as const, fileId: 'b' },
      ],
    };
    expect(richBlocksFor(album)[1]).toEqual({
      type: 'collage',
      blocks: [
        { type: 'photo', photo: { type: 'photo', media: 'a', has_spoiler: true } },
        { type: 'video', video: { type: 'video', media: 'b', has_spoiler: undefined } },
      ],
    });
  });

  it('wraps a rich source in its custom text and attribution', () => {
    const source = { type: 'heading' as const, text: 'Title', size: 1 as const };
    expect(richBlocksFor({ type: 'rich', blocks: [source], text: `Mine${VIA}`, attribution: VIA })).toEqual([
      { type: 'paragraph', text: 'Mine' },
      source,
      viaBlock,
    ]);
  });

  it('sends rich content with sendRichMessage and reports one message', async () => {
    const sendRichMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    const sender = new MediaSenderService({ sendRichMessage } as unknown as Api);
    expect(await sender.sendAll(1, photo, undefined, true)).toEqual([42]);
    expect(sendRichMessage).toHaveBeenCalledWith(1, { blocks: richBlocksFor(photo) }, {});
  });
});
