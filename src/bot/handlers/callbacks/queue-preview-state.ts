// src/bot/handlers/callbacks/queue-preview-state.ts

export interface QueuePreviewState {
  previewMessageIds: number[];
  postId: string;
  controlMessageId: number;
  queueMessageId: number;
  channelId: string;
  page: number;
}

// Per user, keyed by the preview's control message: Delete, Back and the reply buttons are
// tapped on it, so each acts on its own preview even with several open, the same post's among them.
// ponytail: a preview the user never closes stays until restart; prune by age if that ever matters.
const queuePreviews = new Map<number, Map<number, QueuePreviewState>>();

export const saveQueuePreview = (userId: number, state: QueuePreviewState): void => {
  const previews = queuePreviews.get(userId) ?? new Map<number, QueuePreviewState>();
  queuePreviews.set(userId, previews.set(state.controlMessageId, state));
};

export const getQueuePreview = (userId: number, controlMessageId: number): QueuePreviewState | undefined =>
  queuePreviews.get(userId)?.get(controlMessageId);

/** Stops tracking the preview shown by this control message and returns it. */
export const takeQueuePreview = (userId: number, controlMessageId: number): QueuePreviewState | undefined => {
  const state = getQueuePreview(userId, controlMessageId);
  queuePreviews.get(userId)?.delete(controlMessageId);
  return state;
};

/** Stops tracking every open preview of this post and returns them, oldest first. */
export const takeQueuePreviewsOfPost = (userId: number, postId: string): QueuePreviewState[] => {
  const entries = [...(queuePreviews.get(userId) ?? [])];
  if (entries.length === 0) return [];
  queuePreviews.set(userId, new Map(entries.filter(([, state]) => state.postId !== postId)));
  return entries.map(([, state]) => state).filter((state) => state.postId === postId);
};
