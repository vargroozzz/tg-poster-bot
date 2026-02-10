import { Schema, model, Document } from 'mongoose';

export interface IUserNickname extends Document {
  userId: number;
  nickname: string;
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
 * Set custom nickname for a user
 */
export async function setUserNickname(userId: number, nickname: string, notes?: string): Promise<void> {
  await UserNickname.findOneAndUpdate(
    { userId },
    { nickname, notes, addedAt: new Date() },
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
