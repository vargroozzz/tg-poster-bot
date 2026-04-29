// src/utils/post-interval.ts
import { BotSettings } from '../database/models/bot-settings.model.js';

export const VALID_INTERVALS = [15, 30, 60] as const;
export type PostInterval = (typeof VALID_INTERVALS)[number];

export async function getPostInterval(): Promise<PostInterval> {
  const setting = await BotSettings.findOne({ key: 'post_interval' });
  const parsed = parseInt(setting?.value ?? '30', 10);
  return VALID_INTERVALS.includes(parsed as PostInterval) ? (parsed as PostInterval) : 30;
}

export async function setPostInterval(minutes: PostInterval): Promise<void> {
  await BotSettings.findOneAndUpdate(
    { key: 'post_interval' },
    { key: 'post_interval', value: String(minutes), updatedAt: new Date() },
    { upsert: true, new: true }
  );
}
