// src/bot/handlers/callbacks/edit-entry.ts
import { QUEUED_STATUSES, WAITING_PARENT, FAILED, slotOf, type IScheduledPost } from '../../../database/models/scheduled-post.model.js';

/**
 * What a reply keeps when an edit moves it to another channel: the published message it
 * answers, or the queued parent it waits on. reply_parameters names the chat, so it may sit in
 * another channel, as at creation.
 */
export const movedReplyFields = (
  post: Pick<
    IScheduledPost,
    '_id' | 'scheduledTime' | 'status' | 'sameSlot' | 'slotPostId' | 'parentPostId' | 'replyToChannelId' | 'replyToMessageId'
  > | null
) => ({
  replyTo:
    post?.replyToChannelId && post.replyToMessageId
      ? { replyToChannelId: post.replyToChannelId, replyToMessageId: post.replyToMessageId }
      : undefined,
  parentPostId: post?.status === WAITING_PARENT ? post.parentPostId : undefined,
  // A same-slot reply keeps going out with its parent; once that went out, it takes a slot.
  sameSlot: post?.sameSlot && post.status === WAITING_PARENT ? slotOf(post) : undefined,
});

/** Why an edit of this post can't start (/failed, (✏️ Edit) or restart (preview Back); undefined when it can. */
export const editEntryBlocker = (
  post: Pick<IScheduledPost, 'status'>,
  channelCount: number
): string | undefined =>
  post.status === 'posted'
    ? '❌ Post already published'
    : // A failed one too: /failed edits it, and ✅ Schedule puts it back in the queue.
      post.status !== FAILED && !QUEUED_STATUSES.some((s) => s === post.status)
      ? '❌ Post is no longer queued'
      : channelCount === 0
        ? '⚠️ No posting channels configured. Use /addchannel first.'
        : undefined;
