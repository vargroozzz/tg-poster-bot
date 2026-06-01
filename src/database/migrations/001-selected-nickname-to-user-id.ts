import mongoose from 'mongoose';
import { UserNickname } from '../models/user-nickname.model.js';

/**
 * Migrates ScheduledPost documents from the old selectedNickname (string) field
 * to the new selectedUserId (number) field.
 *
 * Run once after deploying the selectedUserId schema change.
 */
export async function migrateSelectedNicknameToUserId(): Promise<void> {
  const collection = mongoose.connection.collection('scheduledposts');

  const postsWithNickname = await collection
    .find({ selectedNickname: { $exists: true, $ne: null }, selectedUserId: { $exists: false } })
    .toArray();

  console.log(`Found ${postsWithNickname.length} posts to migrate`);

  if (postsWithNickname.length === 0) return;

  const allNicknames = await UserNickname.find().lean();
  const nicknameToUserId = new Map(allNicknames.map((n) => [n.nickname, n.userId]));

  // Optional: map old nickname strings to their current names for renamed users.
  // Set env var: NICKNAME_RENAMES='{"old name":"new name"}'
  const renameMap: Record<string, string> = process.env.NICKNAME_RENAMES
    ? JSON.parse(process.env.NICKNAME_RENAMES)
    : {};

  let migrated = 0;
  let skipped = 0;

  for (const post of postsWithNickname) {
    const nickname = post.selectedNickname as string;
    const resolvedNickname = renameMap[nickname] ?? nickname;
    const userId = nicknameToUserId.get(resolvedNickname);

    if (userId == null) {
      console.warn(`Cannot resolve nickname "${nickname}" (post ${post._id}) — skipping`);
      skipped++;
      continue;
    }

    if (resolvedNickname !== nickname) {
      console.log(`Renamed "${nickname}" → "${resolvedNickname}" → userId ${userId} (post ${post._id})`);
    }

    await collection.updateOne({ _id: post._id }, { $set: { selectedUserId: userId }, $unset: { selectedNickname: '' } });
    migrated++;
  }

  console.log(`Migration complete: ${migrated} migrated, ${skipped} skipped`);
}
