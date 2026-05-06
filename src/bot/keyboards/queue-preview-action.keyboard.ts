import { InlineKeyboard } from 'grammy';

export function createQueuePreviewActionKeyboard(postId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✏️ Edit', `queue:edit:${postId}`)
    .text('🗑 Delete post', `queue:del:${postId}`)
    .row()
    .text('⬅ Back to queue', 'queue:back');
}
