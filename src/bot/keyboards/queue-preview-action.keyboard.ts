import { InlineKeyboard } from 'grammy';
import { REPLY_FROM_QUEUE, replyCallback } from '../../shared/constants/reply-callbacks.js';
import { editPostCallback } from '../../shared/constants/edit-callbacks.js';
import {
  QUEUE_BACK,
  queueDeleteCallback,
  DELETE_KEEP_REPLIES,
  DELETE_WITH_REPLIES,
  DELETE_CANCEL,
} from '../../shared/constants/queue-callbacks.js';

export function createQueuePreviewActionKeyboard(postId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✏️ Edit', editPostCallback(postId))
    .text('🗑 Delete post', queueDeleteCallback(postId))
    .row()
    .text('💬 Add reply', replyCallback(REPLY_FROM_QUEUE, postId))
    .text('❝ Add quoted reply', replyCallback(REPLY_FROM_QUEUE, postId, true))
    .row()
    .text('⬅ Back to queue', QUEUE_BACK);
}

/** Asked before deleting a post that has same-slot replies; keeping them comes first. */
export function createDeleteRepliesKeyboard(postId: string, replyCount: number): InlineKeyboard {
  const replies = replyCount === 1 ? 'its reply' : `its ${replyCount} replies`;
  return new InlineKeyboard()
    .text(`🗑 Delete, keep ${replies}`, queueDeleteCallback(postId, DELETE_KEEP_REPLIES))
    .row()
    .text(`🗑 Delete with ${replies}`, queueDeleteCallback(postId, DELETE_WITH_REPLIES))
    .row()
    .text('⬅ Cancel', queueDeleteCallback(postId, DELETE_CANCEL));
}
