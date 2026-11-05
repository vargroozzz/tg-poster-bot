import mongoose from 'mongoose';
import { ScheduledPost, QUEUED_STATUSES, WAITING_PARENT, SLOT_INDEX_NAME } from '../models/scheduled-post.model.js';
import type { ForwardInfo, MessageContent, TextHandling, TransformAction } from '../../types/message.types.js';
import { logger } from '../../utils/logger.js';

// A together reply as it used to be stored, inside its parent post.
interface LegacyEmbeddedReply {
  targetChannelId: string;
  content: MessageContent;
  rawContent?: MessageContent;
  action: TransformAction;
  textHandling?: TextHandling;
  selectedUserId?: number | null;
  customText?: string;
  textAbove?: boolean;
  spoilers?: boolean[];
  originalForward: ForwardInfo;
  // Index of the earlier chain entry it answers; absent or null = the post itself.
  replyTo?: number | null;
}

/**
 * Same-slot replies became posts of their own. Idempotent, so it runs on every startup:
 * 1. stores sameSlot: false on the slot holders created before the field existed;
 * 2. swaps the full unique slot index for the partial one that leaves same-slot replies out;
 * 3. turns together replies still embedded in a queued post into same-slot reply posts.
 */
export async function migrateSameSlotReplies(): Promise<void> {
  const collection = mongoose.connection.collection('scheduledposts');

  await collection.updateMany({ sameSlot: { $exists: false } }, { $set: { sameSlot: false } });

  const indexes = await collection.indexes();
  const legacy = indexes.find(
    (idx) =>
      idx.name !== SLOT_INDEX_NAME &&
      idx.unique &&
      idx.key?.scheduledTime === 1 &&
      idx.key?.targetChannelId === 1 &&
      Object.keys(idx.key).length === 2
  );
  if (legacy?.name) {
    await collection.dropIndex(legacy.name);
    logger.info(`Dropped legacy slot index "${legacy.name}"`);
  }
  await ScheduledPost.createIndexes();

  const converted = await convertEmbeddedReplies(collection);
  if (converted > 0) logger.info(`Converted ${converted} embedded repl${converted === 1 ? 'y' : 'ies'} to posts`);
}

// One post at a time: its reply posts are created first, then its embedded replies are unset,
// so a crash in between loses nothing — the rerun finds the ones it made and creates the rest.
// shortcut: two instances converting the same post at once could each create a reply; the
// window is one startup, add a unique key on (slotPostId, createdAt) if it ever bites.
async function convertEmbeddedReplies(collection: mongoose.mongo.Collection): Promise<number> {
  const post = await collection.findOne({
    status: { $in: [...QUEUED_STATUSES] },
    $or: [{ embeddedReplies: { $exists: true } }, { embeddedReply: { $exists: true } }],
  });
  if (!post) return 0;

  const replies: LegacyEmbeddedReply[] = post.embeddedReplies ?? (post.embeddedReply ? [post.embeddedReply] : []);
  const parentId = post._id.toString();
  // Fixed per post, so a rerun finds the replies an earlier run created; replies go out in this order.
  const baseTime = post._id.getTimestamp().getTime();

  // Sequential: an entry answering an earlier one needs that one's id.
  await replies.reduce<Promise<string[]>>(async (previous, reply, i) => {
    const ids = await previous;
    const createdAt = new Date(baseTime + i);
    const created = await ScheduledPost.findOneAndUpdate(
      { slotPostId: parentId, sameSlot: true, createdAt },
      {
        $setOnInsert: {
          scheduledTime: post.scheduledTime,
          targetChannelId: reply.targetChannelId,
          status: WAITING_PARENT,
          sameSlot: true,
          slotPostId: parentId,
          parentPostId: reply.replyTo == null ? parentId : ids[reply.replyTo],
          action: reply.action,
          originalForward: reply.originalForward,
          content: reply.content,
          rawContent: reply.rawContent,
          textHandling: reply.textHandling,
          selectedUserId: reply.selectedUserId ?? null,
          customText: reply.customText,
          textAbove: reply.textAbove,
          spoilers: reply.spoilers,
          createdAt,
        },
      },
      { upsert: true, new: true }
    );
    return [...ids, created._id.toString()];
  }, Promise.resolve([]));

  await collection.updateOne({ _id: post._id }, { $unset: { embeddedReplies: '', embeddedReply: '' } });
  return replies.length + (await convertEmbeddedReplies(collection));
}
