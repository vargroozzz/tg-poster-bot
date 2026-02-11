import { BaseRepository } from './base.repository.js';
import { ChannelList, type IChannelList } from '../models/channel-list.model.js';

/**
 * Repository for channel lists (green/red lists)
 * Handles channel attribution rules
 */
export class ChannelListRepository extends BaseRepository<IChannelList> {
  constructor() {
    super(ChannelList);
  }

  /**
   * Check if a channel is green-listed
   * Green-listed channels are auto-forwarded without transformation
   */
  async isGreenListed(channelId: string): Promise<boolean> {
    const channel = await this.model.findOne({ channelId, listType: 'green' });
    return channel !== null;
  }

  /**
   * Check if a channel is red-listed
   * Red-listed channels are auto-transformed and hide channel attribution
   */
  async isRedListed(channelId: string): Promise<boolean> {
    const channel = await this.model.findOne({ channelId, listType: 'red' });
    return channel !== null;
  }

  /**
   * Get all green-listed channels
   */
  async getGreenList(): Promise<IChannelList[]> {
    return await this.model.find({ listType: 'green' }).sort({ addedAt: -1 });
  }

  /**
   * Get all red-listed channels
   */
  async getRedList(): Promise<IChannelList[]> {
    return await this.model.find({ listType: 'red' }).sort({ addedAt: -1 });
  }

  /**
   * Add a channel to a list (green or red)
   */
  async addToList(
    channelId: string,
    listType: 'green' | 'red',
    channelTitle?: string,
    channelUsername?: string
  ): Promise<IChannelList> {
    // Remove from other list if exists
    const otherListType = listType === 'green' ? 'red' : 'green';
    await this.model.deleteOne({ channelId, listType: otherListType });

    // Check if already in this list
    const existing = await this.model.findOne({ channelId, listType });
    if (existing) {
      return existing;
    }

    // Create new entry
    return await this.create({
      channelId,
      listType,
      channelTitle,
      channelUsername,
      addedAt: new Date(),
    } as Partial<IChannelList>);
  }

  /**
   * Remove a channel from all lists
   */
  async removeFromAllLists(channelId: string): Promise<number> {
    return await this.deleteMany({ channelId });
  }

  /**
   * Get list type for a channel (green, red, or null if not listed)
   */
  async getListType(channelId: string): Promise<'green' | 'red' | null> {
    const channel = await this.model.findOne({ channelId });
    return channel?.listType ?? null;
  }
}
