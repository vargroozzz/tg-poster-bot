import { listUserNicknames, getUserNickname } from '../../database/models/user-nickname.model.js';
import { ScheduledPost } from '../../database/models/scheduled-post.model.js';
import { createNicknameSelectKeyboard } from '../../bot/keyboards/nickname-select.keyboard.js';

export interface NicknameOption {
  userId: number;
  nickname: string;
}

async function getNicknameUsageCounts(): Promise<Map<number, number>> {
  const results = await ScheduledPost.aggregate<{ _id: number; count: number }>([
    { $match: { selectedUserId: { $ne: null } } },
    { $group: { _id: '$selectedUserId', count: { $sum: 1 } } },
  ]);
  return new Map(results.map((r) => [r._id, r.count]));
}

export async function getNicknameOptions(): Promise<NicknameOption[]> {
  const [nicknames, usageCounts] = await Promise.all([listUserNicknames(), getNicknameUsageCounts()]);
  return nicknames
    .map((n) => ({ userId: n.userId, nickname: n.nickname, usageCount: usageCounts.get(n.userId) ?? 0 }))
    .toSorted((a, b) => a.usageCount - b.usageCount)
    .map(({ userId, nickname }) => ({ userId, nickname }));
}

export async function getNicknameKeyboard() {
  return createNicknameSelectKeyboard(await getNicknameOptions());
}

export async function findNicknameByUserId(userId: number): Promise<string | null> {
  return getUserNickname(userId);
}
