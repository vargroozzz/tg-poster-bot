import 'dotenv/config';
import mongoose from 'mongoose';
import { migrateSelectedNicknameToUserId } from './001-selected-nickname-to-user-id.js';
import { dropScheduledPostTtlIndex } from './002-drop-ttl-index.js';
import { migrateSameSlotReplies } from './003-same-slot-replies.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) throw new Error('MONGODB_URI is not set');

await mongoose.connect(MONGODB_URI);
console.log('Connected to MongoDB');

try {
  await migrateSelectedNicknameToUserId();
  await dropScheduledPostTtlIndex();
  await migrateSameSlotReplies();
} finally {
  await mongoose.disconnect();
}
