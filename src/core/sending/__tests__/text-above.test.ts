import { describe, it, expect, vi } from 'vitest';
import type { Api } from 'grammy';
import { MediaSenderService, supportsTextAbove } from '../media-sender.service.js';

const photo = { type: 'photo' as const, fileId: 'f1', text: 'caption' };

describe('supportsTextAbove', () => {
  it('accepts photo, video, animation and albums led by one of them', () => {
    expect(supportsTextAbove(photo)).toBe(true);
    expect(supportsTextAbove({ type: 'video', fileId: 'f', text: 'x' })).toBe(true);
    expect(supportsTextAbove({ type: 'animation', fileId: 'f', text: 'x' })).toBe(true);
    expect(
      supportsTextAbove({
        type: 'media_group',
        text: 'x',
        mediaGroup: [{ type: 'photo', fileId: 'a' }, { type: 'photo', fileId: 'b' }],
      })
    ).toBe(true);
  });

  it('rejects captionless placement: no text, plain text posts, and unsupported media', () => {
    expect(supportsTextAbove({ type: 'photo', fileId: 'f' })).toBe(false);
    expect(supportsTextAbove({ type: 'text', text: 'x' })).toBe(false);
    expect(supportsTextAbove({ type: 'document', fileId: 'f', text: 'x' })).toBe(false);
    expect(
      supportsTextAbove({
        type: 'media_group',
        text: 'x',
        mediaGroup: [{ type: 'document', fileId: 'a' }],
      })
    ).toBe(false);
  });
});

describe('MediaSenderService text placement', () => {
  const mockApi = () =>
    ({
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 2 }, { message_id: 3 }]),
    }) as unknown as Api;

  it('sets show_caption_above_media only when text is above', async () => {
    const api = mockApi();
    const sender = new MediaSenderService(api);

    await sender.sendMessage('-100', photo, undefined, true);
    await sender.sendMessage('-100', photo, undefined, false);

    const [above, below] = vi.mocked(api.sendPhoto).mock.calls;
    expect(above[2]).toMatchObject({ show_caption_above_media: true });
    expect(below[2]).not.toHaveProperty('show_caption_above_media');
  });

  it('flags only the captioned album item', async () => {
    const api = mockApi();
    const sender = new MediaSenderService(api);

    await sender.sendMessage(
      '-100',
      {
        type: 'media_group',
        text: 'caption',
        mediaGroup: [{ type: 'photo', fileId: 'a' }, { type: 'photo', fileId: 'b' }],
      },
      undefined,
      true
    );

    const [, media] = vi.mocked(api.sendMediaGroup).mock.calls[0];
    expect(media[0]).toMatchObject({ caption: 'caption', show_caption_above_media: true });
    expect(media[1]).not.toHaveProperty('show_caption_above_media');
  });
});
