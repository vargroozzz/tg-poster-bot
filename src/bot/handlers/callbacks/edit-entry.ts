// src/bot/handlers/callbacks/edit-entry.ts
import { QUEUED_STATUSES, type IScheduledPost } from '../../../database/models/scheduled-post.model.js';

/** Why an edit of this post can't start (✏️ Edit) or restart (preview Back); undefined when it can. */
export const editEntryBlocker = (
  post: Pick<IScheduledPost, 'status'>,
  channelCount: number
): string | undefined =>
  post.status === 'posted'
    ? '❌ Post already published'
    : !QUEUED_STATUSES.some((s) => s === post.status)
      ? '❌ Post is no longer queued'
      : channelCount === 0
        ? '⚠️ No posting channels configured. Use /addchannel first.'
        : undefined;
