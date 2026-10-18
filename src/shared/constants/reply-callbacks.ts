import { OBJECT_ID_SOURCE } from './object-id.js';

/** Callback prefixes for 💬 Add reply: from the scheduled-post confirmation and the queue preview. */
export const REPLY_FROM_CONFIRMATION = 'reply_trigger';
export const REPLY_FROM_QUEUE = 'queue_reply';

/** Suffix for the ❝ Add quoted reply variant, which first sends the post to quote-reply to. */
export const QUOTED_REPLY_SUFFIX = '_quote';

export const replyCallback = (prefix: string, postId: string, quoted = false): string =>
  `${prefix}${quoted ? QUOTED_REPLY_SUFFIX : ''}:${postId}`;

/** Groups: [1] prefix, [2] quoted suffix (or undefined), [3] post id. */
export const REPLY_CALLBACK_PATTERN = new RegExp(
  `^(${REPLY_FROM_CONFIRMATION}|${REPLY_FROM_QUEUE})(${QUOTED_REPLY_SUFFIX})?:(${OBJECT_ID_SOURCE})$`
);
