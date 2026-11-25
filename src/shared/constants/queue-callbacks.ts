import { OBJECT_ID_SOURCE } from './object-id.js';

/** Callback prefix for 🗑 Delete post on the queue preview. */
export const QUEUE_DELETE = 'queue:del';

/** What a delete does with the same-slot replies under the post, once asked. */
export const DELETE_KEEP_REPLIES = 'keep';
export const DELETE_WITH_REPLIES = 'all';
export const DELETE_CANCEL = 'cancel';
type DeleteChoice = typeof DELETE_KEEP_REPLIES | typeof DELETE_WITH_REPLIES | typeof DELETE_CANCEL;

export const queueDeleteCallback = (postId: string, choice?: DeleteChoice): string =>
  `${QUEUE_DELETE}:${postId}${choice ? `:${choice}` : ''}`;

/** Groups: [1] the post id, [2] the choice (or undefined: not asked yet). */
export const QUEUE_DELETE_PATTERN = new RegExp(
  `^${QUEUE_DELETE}:(${OBJECT_ID_SOURCE})(?::(${DELETE_KEEP_REPLIES}|${DELETE_WITH_REPLIES}|${DELETE_CANCEL}))?$`
);

/** Callback data for ⬅ Back to queue on the queue preview. */
export const QUEUE_BACK = 'queue:back';
