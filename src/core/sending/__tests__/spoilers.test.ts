import { describe, it, expect } from 'vitest';
import type { MessageContent } from '../../../types/message.types.js';
import { ScheduledPost } from '../../../database/models/scheduled-post.model.js';
import { nextSpoilers, spoilerSlots, withSpoilers } from '../spoilers.js';

const album: MessageContent = {
  type: 'media_group',
  text: 'caption',
  mediaGroup: [
    { type: 'photo', fileId: 'a' },
    { type: 'document', fileId: 'b' },
    { type: 'video', fileId: 'c', hasSpoiler: true },
  ],
};

describe('withSpoilers', () => {
  it('leaves content untouched when the user never chose', () => {
    const photo: MessageContent = { type: 'photo', fileId: 'f', hasSpoiler: true };
    expect(withSpoilers(photo, undefined)).toBe(photo);
  });

  it('overrides a single medium, in both directions', () => {
    const photo: MessageContent = { type: 'photo', fileId: 'f', hasSpoiler: true };
    expect(withSpoilers(photo, [false])).toMatchObject({ hasSpoiler: false });
    expect(withSpoilers({ type: 'animation', fileId: 'f' }, [true])).toMatchObject({ hasSpoiler: true });
  });

  it('keeps the source flag where the override says nothing', () => {
    const photo: MessageContent = { type: 'photo', fileId: 'f', hasSpoiler: true };
    expect(withSpoilers(photo, [])).toMatchObject({ hasSpoiler: true });
  });

  it('applies album overrides by position and skips media that cannot spoiler', () => {
    const result = withSpoilers(album, [true, true, false]);
    if (result.type !== 'media_group') throw new Error('expected an album');

    expect(result.mediaGroup[0]).toMatchObject({ hasSpoiler: true });
    // The document keeps no spoiler even though its position was set to true.
    expect(result.mediaGroup[1]).toMatchObject({ type: 'document', fileId: 'b' });
    expect(result.mediaGroup[1].hasSpoiler).toBeFalsy();
    expect(result.mediaGroup[2]).toMatchObject({ hasSpoiler: false });
  });

  it('does not mutate the content it was given', () => {
    withSpoilers(album, [true, true, false]);
    if (album.type !== 'media_group') throw new Error('expected an album');
    expect(album.mediaGroup[0]).not.toHaveProperty('hasSpoiler');
  });

  it('ignores content with no spoilerable media', () => {
    const doc: MessageContent = { type: 'document', fileId: 'f', text: 'x' };
    expect(withSpoilers(doc, [true])).toEqual(doc);
  });

  // A post read back from MongoDB carries its album items as Mongoose subdocuments, whose
  // schema fields sit on the prototype. Spreading one drops type/fileId and Telegram then
  // rejects the album, so the override has to rebuild each item field by field.
  it('keeps type and fileId when the album comes from a Mongoose document', () => {
    const post = new ScheduledPost({
      scheduledTime: new Date(),
      targetChannelId: '-100',
      status: 'pending',
      action: 'transform',
      originalForward: { messageId: 1, chatId: 2 },
      content: {
        type: 'media_group',
        text: 'caption',
        mediaGroup: [
          { type: 'photo', fileId: 'a' },
          { type: 'video', fileId: 'b' },
        ],
      },
      createdAt: new Date(),
    });

    const result = withSpoilers(post.content, [true, false]);
    if (result.type !== 'media_group') throw new Error('expected an album');

    expect(result.mediaGroup).toEqual([
      { type: 'photo', fileId: 'a', hasSpoiler: true },
      { type: 'video', fileId: 'b', hasSpoiler: false },
    ]);
  });
});

describe('spoilerSlots', () => {
  it('reports spoilerable album positions with their current state', () => {
    expect(spoilerSlots(album)).toEqual([
      { index: 0, on: false },
      { index: 2, on: true },
    ]);
  });

  it('uses index 0 for a single medium and is empty for the unsupported ones', () => {
    expect(spoilerSlots({ type: 'video', fileId: 'f', hasSpoiler: true })).toEqual([{ index: 0, on: true }]);
    expect(spoilerSlots({ type: 'document', fileId: 'f' })).toEqual([]);
    expect(spoilerSlots({ type: 'text', text: 'x' })).toEqual([]);
  });
});

describe('nextSpoilers', () => {
  it('states every album position, spoilerable or not', () => {
    expect(nextSpoilers(album, () => true)).toEqual([true, false, true]);
  });

  it('flips one slot and leaves the others as they render', () => {
    expect(nextSpoilers(album, (slot) => (slot.index === 0 ? !slot.on : slot.on))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('round-trips through withSpoilers', () => {
    const turnedOff = withSpoilers(album, nextSpoilers(album, () => false));
    expect(spoilerSlots(turnedOff)).toEqual([
      { index: 0, on: false },
      { index: 2, on: false },
    ]);
  });
});
