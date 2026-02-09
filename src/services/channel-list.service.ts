import { ChannelList, type IChannelList, type ListType } from '../database/models/channel-list.model.js';
import { logger } from '../utils/logger.js';

export class ChannelListService {
  async isGreenListed(channelId: string): Promise<boolean> {
    try {
      const channel = await ChannelList.findOne({ channelId, listType: 'green' });
      return channel !== null;
    } catch (error) {
      logger.error(`Error checking green list for channel ${channelId}:`, error);
      return false;
    }
  }

  async isRedListed(channelId: string): Promise<boolean> {
    try {
      const channel = await ChannelList.findOne({ channelId, listType: 'red' });
      return channel !== null;
    } catch (error) {
      logger.error(`Error checking red list for channel ${channelId}:`, error);
      return false;
    }
  }

  async addChannel(
    channelId: string,
    listType: ListType,
    metadata?: {
      channelUsername?: string;
      channelTitle?: string;
      notes?: string;
    }
  ): Promise<void> {
    try {
      await ChannelList.findOneAndUpdate(
        { channelId },
        {
          channelId,
          listType,
          ...metadata,
          addedAt: new Date(),
        },
        { upsert: true, new: true }
      );
      logger.info(`Added channel ${channelId} to ${listType} list`);
    } catch (error) {
      logger.error(`Error adding channel ${channelId} to ${listType} list:`, error);
      throw error;
    }
  }

  async removeChannel(channelId: string): Promise<boolean> {
    try {
      const result = await ChannelList.deleteOne({ channelId });
      if (result.deletedCount > 0) {
        logger.info(`Removed channel ${channelId} from lists`);
        return true;
      }
      return false;
    } catch (error) {
      logger.error(`Error removing channel ${channelId}:`, error);
      throw error;
    }
  }

  async listChannels(): Promise<IChannelList[]> {
    try {
      return await ChannelList.find().sort({ addedAt: -1 });
    } catch (error) {
      logger.error('Error listing channels:', error);
      throw error;
    }
  }
}

export const channelListService = new ChannelListService();
