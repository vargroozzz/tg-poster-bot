import { listUserNicknames } from '../../database/models/user-nickname.model.js';
import { createNicknameSelectKeyboard } from '../../bot/keyboards/nickname-select.keyboard.js';

export interface NicknameOption {
  userId: number;
  nickname: string;
}

export async function getNicknameOptions(): Promise<NicknameOption[]> {
  const nicknames = await listUserNicknames();
  return nicknames.map((n) => ({ userId: n.userId, nickname: n.nickname }));
}

export async function getNicknameKeyboard() {
  return createNicknameSelectKeyboard(await getNicknameOptions());
}

export async function findNicknameByUserId(userId: number): Promise<string | null> {
  const nicknames = await listUserNicknames();
  return nicknames.find((n) => n.userId === userId)?.nickname ?? null;
}

export async function parseNicknameSelection(selection: string): Promise<string | null> {
  if (selection === 'none') return null;
  const userId = parseInt(selection, 10);
  if (isNaN(userId)) return null;
  return findNicknameByUserId(userId);
}
