import { InlineKeyboard } from 'grammy';
import { REPLY_FROM_QUEUE, replyCallback } from '../../shared/constants/reply-callbacks.js';

export function createQueuePreviewActionKeyboard(postId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✏️ Edit', `queue:edit:${postId}`)
    .text('🗑 Delete post', `queue:del:${postId}`)
    .row()
    .text('💬 Add reply', replyCallback(REPLY_FROM_QUEUE, postId))
    .text('❝ Add quoted reply', replyCallback(REPLY_FROM_QUEUE, postId, true))
    .row()
    .text('⬅ Back to queue', 'queue:back');
}
