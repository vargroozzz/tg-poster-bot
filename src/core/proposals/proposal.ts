export type NicknameStatus = 'confirmed' | 'unconfirmed';

// Max un-reviewed proposals an unconfirmed proposer may have outstanding at once.
export const MAX_PENDING_PROPOSALS = 3;

// Commands a non-owner may invoke. Every other command is owner-only.
export const NON_OWNER_COMMANDS: readonly string[] = ['start', 'help', 'setnickname'];

export function normalizeNickname(name: string): string {
  return name.trim().toLowerCase();
}

export function isNicknameTakenIn(
  existing: ReadonlyArray<{ userId: number; nickname: string }>,
  name: string,
  exceptUserId?: number
): boolean {
  const target = normalizeNickname(name);
  return existing.some(
    (n) => normalizeNickname(n.nickname) === target && n.userId !== exceptUserId
  );
}

export function canAcceptProposal(
  status: NicknameStatus,
  pendingCount: number,
  max: number
): boolean {
  return status === 'confirmed' || pendingCount < max;
}

// "/SetNickname@bot Alex" -> "setnickname"; undefined when not a bot command.
export function parseCommandName(text: string | undefined): string | undefined {
  if (!text || !text.startsWith('/')) return undefined;
  const firstToken = text.slice(1).split(/\s+/)[0] ?? '';
  const withoutMention = firstToken.split('@')[0];
  return withoutMention ? withoutMention.toLowerCase() : undefined;
}

// Who to credit: the owner credits the content source; a proposer is always
// credited with their own nickname (their own userId).
export function resolveProposerCredit(
  isOwner: boolean,
  actingUserId: number,
  sourceKnownId: number | undefined
): number | undefined {
  return isOwner ? sourceKnownId : actingUserId;
}
