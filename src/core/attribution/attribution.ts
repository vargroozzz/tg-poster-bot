import { Effect } from 'effect';
import type { ForwardInfo } from '../../types/message.types.js';
import { getUserNickname } from '../../database/models/user-nickname.model.js';
import { ChannelListRepository } from '../../database/repositories/channel-list.repository.js';
import { logger } from '../../utils/logger.js';

const channelListRepo = new ChannelListRepository();

function resolveUserNickname(
  userId: number | undefined,
  manualNickname: string | null | undefined
): Effect.Effect<string | null> {
  if (manualNickname !== undefined) return Effect.succeed(manualNickname);
  if (userId) return Effect.promise(() => getUserNickname(userId));
  return Effect.succeed(null);
}

function buildChannelAttribution(
  forwardInfo: ForwardInfo,
  manualNickname: string | null | undefined
): Effect.Effect<string | null> {
  return Effect.gen(function* () {
    const channelId = String(forwardInfo.fromChannelId);

    const [isGreen, isRed] = yield* Effect.all(
      [
        Effect.promise(() => channelListRepo.isGreenListed(channelId)),
        Effect.promise(() => channelListRepo.isRedListed(channelId)),
      ],
      { concurrency: 'unbounded' }
    );

    if (isGreen) {
      logger.debug(`Channel ${channelId} is green-listed, no attribution needed`);
      return null;
    }

    const userNickname = yield* resolveUserNickname(forwardInfo.fromUserId, manualNickname);

    if (isRed) return userNickname ? `\n\nvia ${userNickname}` : null;

    if (!forwardInfo.messageLink) return null;

    const channelReference =
      forwardInfo.fromChannelUsername ?? forwardInfo.fromChannelTitle ?? 'Unnamed Channel';
    const channelPart = `<a href="${forwardInfo.messageLink}">${channelReference}</a>`;

    return userNickname
      ? `\n\nfrom ${userNickname} via ${channelPart}`
      : `\n\nvia ${channelPart}`;
  });
}

function buildUserAttribution(
  userId: number,
  manualNickname: string | null | undefined
): Effect.Effect<string | null> {
  return Effect.gen(function* () {
    const userNickname = yield* resolveUserNickname(userId, manualNickname);
    return userNickname ? `\n\nvia ${userNickname}` : null;
  });
}

export function buildAttribution(
  forwardInfo: ForwardInfo,
  manualNickname?: string | null
): Promise<string | null> {
  return Effect.runPromise(
    Effect.gen(function* () {
      // When replyParameters is set, fromChannelId/fromUserId were extracted from
      // external_reply — they identify the *quoted* message, not the author.
      // Don't attribute to the quoted channel/user; use only manualNickname.
      if (forwardInfo.fromChannelId && !forwardInfo.replyParameters) {
        return yield* buildChannelAttribution(forwardInfo, manualNickname);
      }
      if (forwardInfo.fromUserId && !forwardInfo.replyParameters) {
        return yield* buildUserAttribution(forwardInfo.fromUserId, manualNickname);
      }
      if (manualNickname !== undefined && manualNickname !== null) {
        return `\n\nvia ${manualNickname}`;
      }
      return null;
    })
  );
}
