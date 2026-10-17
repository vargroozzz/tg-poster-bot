import { InlineKeyboard } from 'grammy';
import { REPLY_FROM_QUEUE, replyCallback } from '../../shared/constants/reply-callbacks.js';
import { editPostCallback } from '../../shared/constants/edit-callbacks.js';
import { QUEUE_BACK, queueDeleteCallback } from '../../shared/constants/queue-callbacks.js';

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
