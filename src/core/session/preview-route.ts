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
