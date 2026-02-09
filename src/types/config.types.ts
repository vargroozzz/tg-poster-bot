export interface Config {
  botToken: string;
  mongodbUri: string;
  targetChannelId?: string;
  authorizedUserId: number;
  nodeEnv: 'development' | 'production' | 'test';
  timezone: string;
}
