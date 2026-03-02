import { InlineKeyboard } from 'grammy';

interface QueueListKeyboardParams {
  postIds: string[];
  channelId: string;
  page: number;
  totalPages: number;
}

export function createQueueListKeyboard({
  postIds,
  channelId,
  page,
  totalPages,
}: QueueListKeyboardParams): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // One preview button per post on this page
  const pageOffset = (page - 1) * 5;
  postIds.forEach((postId, index) => {
    keyboard.text(`👁 ${pageOffset + index + 1}`, `queue:preview:${postId}:${channelId}:${page}`);
  });
  keyboard.row();

  // Navigation row
  if (page > 1) {
    keyboard.text('← Prev', `queue:ch:${channelId}:${page - 1}`);
  }
  keyboard.text(`${page}/${totalPages}`, 'queue:noop');
  if (page < totalPages) {
    keyboard.text('Next →', `queue:ch:${channelId}:${page + 1}`);
  }
  keyboard.row();

  keyboard.text('← Channels', 'queue:channels');

  return keyboard;
}
