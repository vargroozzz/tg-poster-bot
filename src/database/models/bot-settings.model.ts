import mongoose, { Schema, Document } from 'mongoose';

export interface IBotSettings extends Document {
  key: string;
  value: string;
  updatedAt: Date;
}

const botSettingsSchema = new Schema<IBotSettings>({
  key: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  value: {
    type: String,
    required: true,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

export const BotSettings = mongoose.model<IBotSettings>('BotSettings', botSettingsSchema);

// Helper functions for common settings
export async function getTargetChannelId(): Promise<string | null> {
  const setting = await BotSettings.findOne({ key: 'targetChannelId' });
  return setting?.value ?? null;
}

export async function setTargetChannelId(channelId: string): Promise<void> {
  await BotSettings.findOneAndUpdate(
    { key: 'targetChannelId' },
    { key: 'targetChannelId', value: channelId, updatedAt: new Date() },
    { upsert: true, new: true }
  );
}
