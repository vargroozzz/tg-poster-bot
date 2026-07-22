import { Schema, model, Document } from 'mongoose';
import { isNicknameTakenIn, type NicknameStatus } from '../../core/proposals/proposal.js';

export interface IUserNickname extends Document {
  userId: number;
  nickname: string;
  status: NicknameStatus;
  addedAt: Date;
  notes?: string;
}

const userNicknameSchema = new Schema<IUserNickname>({
  userId: {
    type: Number,
    required: true,
    unique: true,
  },
  nickname: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['confirmed', 'unconfirmed'],
    default: 'confirmed',
  },
  addedAt: {
    type: Date,
    default: Date.now,
  },
  notes: {
    type: String,
  },
});

export const UserNickname = model<IUserNickname>('UserNickname', userNicknameSchema);

/**
 * Get custom nickname for a user
 */
export async function getUserNickname(userId: number): Promise<string | null> {
  const userNick = await UserNickname.findOne({ userId });
  return userNick?.nickname ?? null;
}

/**
 * Set custom nickname for a user. status defaults to 'confirmed' so the owner's
 * /addnickname path is unchanged; /setnickname passes 'unconfirmed'.
 */
export async function setUserNickname(
  userId: number,
  nickname: string,
  notes?: string,
  status: NicknameStatus = 'confirmed'
): Promise<void> {
  await UserNickname.findOneAndUpdate(
    { userId },
    { nickname, notes, status, addedAt: new Date() },
    { upsert: true }
  );
}

/**
 * Remove custom nickname for a user
 */
export async function removeUserNickname(userId: number): Promise<boolean> {
  const result = await UserNickname.deleteOne({ userId });
  return result.deletedCount > 0;
}

/**
 * Get all user nicknames
 */
export async function listUserNicknames(): Promise<IUserNickname[]> {
  return await UserNickname.find().sort({ addedAt: -1 });
}

/**
 * Get a user's nickname status, or null if they have no nickname.
 */
export async function getUserNicknameStatus(userId: number): Promise<NicknameStatus | null> {
  const doc = await UserNickname.findOne({ userId });
  return doc ? (doc.status as NicknameStatus) : null;
}

/**
 * True if `name` (case-insensitive) is already used by a different user.
 */
export async function isNicknameTaken(name: string, exceptUserId?: number): Promise<boolean> {
  const all = await listUserNicknames();
  return isNicknameTakenIn(
    all.map((n) => ({ userId: n.userId, nickname: n.nickname })),
    name,
    exceptUserId
  );
}

/**
 * Promote a user to 'confirmed' without touching their nickname.
 */
export async function confirmUserNickname(userId: number): Promise<void> {
  await UserNickname.updateOne({ userId }, { $set: { status: 'confirmed' } });
}
