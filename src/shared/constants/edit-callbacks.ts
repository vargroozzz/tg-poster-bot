import type { TextHandling } from '../../types/message.types.js';
import { OBJECT_ID_SOURCE } from './object-id.js';

/** Callback prefix for ✏️ Edit on a scheduled post: the confirmation and the queue preview. */
export const EDIT_POST = 'queue:edit';

export const editPostCallback = (postId: string): string => `${EDIT_POST}:${postId}`;

/** Group [1]: the post's ObjectId. Kept strict so the edit flow's step callbacks don't match. */
export const EDIT_POST_PATTERN = new RegExp(`^${EDIT_POST}:(${OBJECT_ID_SOURCE})$`);

/** The addText step carries no value; this fixed one keeps it in the `<prefix>:<sid>:<value>` shape. */
export const EDIT_ADD_TEXT = 'add';

/** The action and text steps' values: the step types and the handler patterns both read these. */
export const ACTION_CHOICES = ['quick', 'transform', 'forward'] as const;
export const TEXT_CHOICES = ['keep', 'quote', 'remove'] as const satisfies readonly TextHandling[];

/**
 * The edit flow's steps: `<prefix>:<sessionId>:<value>`, with the regex source each step's value
 * must match. Each step has its own prefix under EDIT_POST, except the preset, shortened to `ec:`
 * because callback data is capped at 64 bytes and a preset id (24 chars) rides along with the
 * session id (24).
 */
export const EDIT_STEP = {
  channel: { prefix: `${EDIT_POST}:ch`, value: '-?\\d+' },
  action: { prefix: `${EDIT_POST}:action`, value: ACTION_CHOICES.join('|') },
  text: { prefix: `${EDIT_POST}:text`, value: TEXT_CHOICES.join('|') },
  preset: { prefix: 'ec:preset', value: '.+' },
  addText: { prefix: `${EDIT_POST}:custom`, value: EDIT_ADD_TEXT },
  nickname: { prefix: `${EDIT_POST}:nickname`, value: '[^:]+' },
} as const;

export type EditStep = keyof typeof EDIT_STEP;

export const editStepCallback = (step: EditStep, sessionId: string, value: string): string =>
  `${EDIT_STEP[step].prefix}:${sessionId}:${value}`;

/** Groups: [1] session id, [2] the step's value. */
export const editStepPattern = (step: EditStep): RegExp =>
  new RegExp(`^${EDIT_STEP[step].prefix}:([^:]+):(${EDIT_STEP[step].value})$`);
