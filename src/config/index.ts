import dotenv from 'dotenv';
import { configSchema } from './schema.js';
import type { Config } from '../types/config.types.js';

// Load environment variables
dotenv.config();

function loadConfig(): Config {
  const rawConfig = {
    botToken: process.env.BOT_TOKEN,
    mongodbUri: process.env.MONGODB_URI,
    targetChannelId: process.env.TARGET_CHANNEL_ID,
    authorizedUserId: process.env.AUTHORIZED_USER_ID
      ? parseInt(process.env.AUTHORIZED_USER_ID, 10)
      : undefined,
    nodeEnv: process.env.NODE_ENV ?? 'development',
    timezone: process.env.TZ ?? 'Europe/Kiev',
  };

  const result = configSchema.safeParse(rawConfig);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }

  return result.data;
}

export const config = loadConfig();
