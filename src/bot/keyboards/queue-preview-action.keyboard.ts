import { InlineKeyboard } from 'grammy';

export function createQueuePreviewActionKeyboard(postId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('🗑 Delete post', `queue:del:${postId}`)
    .text('⬅ Back to queue', 'queue:back');
}
