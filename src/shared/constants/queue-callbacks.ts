/** Callback prefix for 🗑 Delete post on the queue preview. */
export const QUEUE_DELETE = 'queue:del';

export const queueDeleteCallback = (postId: string): string => `${QUEUE_DELETE}:${postId}`;

/** Group [1]: the post id. */
export const QUEUE_DELETE_PATTERN = new RegExp(`^${QUEUE_DELETE}:(.+)$`);

/** Callback data for ⬅ Back to queue on the queue preview. */
export const QUEUE_BACK = 'queue:back';
