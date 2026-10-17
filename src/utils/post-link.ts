import type { ChannelLike } from '../shared/helpers/channel.helper.js';

// t.me/<username>/<id> (public channel) or t.me/c/<internal id>/<id> (private channel), as
// Telegram's "Copy post link" gives them; a query string (?single, ?comment=…) is ignored.
const POST_LINK =
  /^(?:https?:\/\/)?(?:t|telegram)\.me\/(?:c\/(\d+)|([A-Za-z]\w{3,31}))\/(\d+)\/?(?:\?\S*)?$/i;

/** Whether the whole text is a post link — a cheap check before looking up the channels. */
export const isPostLink = (text: string | undefined): boolean => POST_LINK.test(text?.trim() ?? '');

/**
 * The post a message's text links to, when the whole text is a post link to one of the given
 * channels. Anything else (other text, another channel's post) is not a link to reply to.
 */
export function findLinkedPost<C extends ChannelLike>(
  text: string | undefined,
  channels: C[]
): { channel: C; messageId: number } | undefined {
  const [, internalId, username, messageId] = text?.trim().match(POST_LINK) ?? [];
  if (!messageId) return undefined;

  const channel = channels.find((c) =>
    internalId
      ? c.channelId === `-100${internalId}`
      : c.channelUsername?.toLowerCase() === username?.toLowerCase()
  );
  return channel && { channel, messageId: Number(messageId) };
}
