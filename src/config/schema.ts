import { z } from 'zod';

export const configSchema = z.object({
  botToken: z.string().min(1, 'BOT_TOKEN is required'),
  mongodbUri: z.string().url('MONGODB_URI must be a valid URL'),
  targetChannelId: z
    .string()
    .regex(/^-\d+$/, 'TARGET_CHANNEL_ID must start with - and be numeric')
    .optional(),
  authorizedUserId: z.number().int().positive('AUTHORIZED_USER_ID must be a positive integer'),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  timezone: z.string().default('Europe/Kiev'),
});

export type ConfigSchema = z.infer<typeof configSchema>;
