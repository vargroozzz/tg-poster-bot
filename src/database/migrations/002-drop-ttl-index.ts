import mongoose from 'mongoose';

/**
 * Drops the TTL index on ScheduledPost.createdAt that was auto-deleting posts after 90 days.
 * Must be run against the live database after deploying the schema change.
 */
export async function dropScheduledPostTtlIndex(): Promise<void> {
  const collection = mongoose.connection.collection('scheduledposts');
  const indexes = await collection.indexes();
  const ttlIndex = indexes.find((idx) => idx.expireAfterSeconds != null && idx.key?.createdAt != null);

  if (!ttlIndex) {
    console.log('TTL index not found — already removed or never existed');
    return;
  }

  await collection.dropIndex(ttlIndex.name as string);
  console.log(`Dropped TTL index "${ttlIndex.name}"`);
}
