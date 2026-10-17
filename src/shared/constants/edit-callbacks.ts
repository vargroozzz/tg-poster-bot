/** Callback prefix for ✏️ Edit on a scheduled post: the confirmation and the queue preview. */
export const EDIT_POST = 'queue:edit';

export const editPostCallback = (postId: string): string => `${EDIT_POST}:${postId}`;

/** Group [1]: the post's ObjectId. Kept strict so the edit flow's step callbacks don't match. */
export const EDIT_POST_PATTERN = new RegExp(`^${EDIT_POST}:([a-f0-9]{24})$`);
