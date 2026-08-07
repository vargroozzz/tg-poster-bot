import type { MessageContent } from '../../types/message.types.js';

// Telegram's has_spoiler only exists on photo, video and animation.
const SPOILERABLE: ReadonlyArray<string> = ['photo', 'video', 'animation'];

/** One spoiler-capable medium in a post: its album position and current state. */
export type SpoilerSlot = { index: number; on: boolean };

/**
 * Apply the user's spoiler choices over the flags the source message came with.
 * `spoilers` is index-aligned to album position (index 0 for a single medium); a nullish
 * entry leaves that item as the source had it, so an untouched post behaves as before.
 */
export function withSpoilers(content: MessageContent, spoilers?: boolean[]): MessageContent {
  if (!spoilers) return content;

  if (content.type === 'media_group') {
    return {
      ...content,
      // Rebuilt field by field, not spread: a post read back from MongoDB carries its album
      // items as Mongoose subdocuments, whose schema fields live on the prototype. Spreading
      // one copies its internals and drops type/fileId, which Telegram then rejects.
      mediaGroup: content.mediaGroup.map((item, index) => ({
        type: item.type,
        fileId: item.fileId,
        hasSpoiler: SPOILERABLE.includes(item.type) ? spoilers[index] ?? item.hasSpoiler : item.hasSpoiler,
      })),
    };
  }

  return content.type === 'photo' || content.type === 'video' || content.type === 'animation'
    ? { ...content, hasSpoiler: spoilers[0] ?? content.hasSpoiler }
    : content;
}

/**
 * The media a spoiler can be toggled on, with the state they currently render at.
 * Read off content that already went through withSpoilers.
 */
export function spoilerSlots(content: MessageContent): SpoilerSlot[] {
  if (content.type === 'media_group') {
    return content.mediaGroup.flatMap((item, index) =>
      SPOILERABLE.includes(item.type) ? [{ index, on: !!item.hasSpoiler }] : []
    );
  }

  return SPOILERABLE.includes(content.type)
    ? [{ index: 0, on: 'hasSpoiler' in content && !!content.hasSpoiler }]
    : [];
}

/**
 * The array to save after `change` decides each slot's new state. Dense and full-length:
 * every position is stated outright, so nothing falls back to a source flag later.
 */
export function nextSpoilers(content: MessageContent, change: (slot: SpoilerSlot) => boolean): boolean[] {
  const slots = spoilerSlots(content);
  const length = content.type === 'media_group' ? content.mediaGroup.length : 1;

  return Array.from({ length }, (_, index) => {
    const slot = slots.find((s) => s.index === index);
    return slot ? change(slot) : false;
  });
}
