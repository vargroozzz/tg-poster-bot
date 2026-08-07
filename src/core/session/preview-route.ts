import type { ISession } from '../../database/models/session.model.js';

/**
 * Which path `preview:schedule` takes when the user confirms. Pure function of
 * session fields — the single source of truth for the confirm routing, so it can
 * be tested without mocking the scheduler/repository/Telegram side effects.
 *
 * Corruption (an edit/reply session missing required fields) is intentionally
 * NOT a route: it's decided once by the guards in confirmEdit/confirmReply,
 * which need those null-checks for type narrowing regardless.
 */
export type ScheduleRoute =
  | 'edit-same-channel'
  | 'edit-move-channel'
  | 'reply-together'
  | 'reply-separated'
  | 'normal';

/**
 * Whether the post has text worth placing above the media: its own body text, either the
 * original (kept or quoted) or an added custom one. A post carrying nothing but the
 * via/from attribution row is excluded — that line reads the same in either position.
 */
export function hasPlaceableText(session: ISession): boolean {
  if (session.customText) return true;
  if (session.textHandling === 'remove') return false;

  // Edit sessions carry the source content directly; live ones still have the message(s).
  const editText =
    session.editingRawContent && 'text' in session.editingRawContent
      ? session.editingRawContent.text
      : undefined;
  const messages = session.mediaGroupMessages?.length
    ? session.mediaGroupMessages
    : session.originalMessage
      ? [session.originalMessage]
      : [];

  return !!editText || messages.some((m) => !!(m.text ?? m.caption));
}

/**
 * Whether this post's text goes above its media. Reading the flag through here keeps a
 * toggle set earlier from leaking onto a post that has since lost its placeable text.
 */
export function textAboveFor(session: ISession): boolean | undefined {
  return hasPlaceableText(session) ? session.textAbove : undefined;
}

/**
 * This post's spoiler overrides, or undefined when they don't apply. A forward reposts the
 * original untouched, so its media keeps whatever spoiler state the source had.
 */
export function spoilersFor(session: ISession): boolean[] | undefined {
  return session.selectedAction === 'forward' ? undefined : session.spoilers;
}

export function classifyScheduleConfirm(session: ISession): ScheduleRoute {
  if (session.editingPostId) {
    return session.selectedChannel === session.editingOriginalChannelId
      ? 'edit-same-channel'
      : 'edit-move-channel';
  }

  if (session.isReply && session.replyParentPostId) {
    return session.replyMode === 'together' ? 'reply-together' : 'reply-separated';
  }

  return 'normal';
}
