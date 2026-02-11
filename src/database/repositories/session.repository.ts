import { BaseRepository } from './base.repository.js';
import { Session, type ISession } from '../models/session.model.js';

/**
 * Repository for user sessions
 * Will be used in Phase 4 to replace in-memory pendingForwards Map
 */
export class SessionRepository extends BaseRepository<ISession> {
  constructor() {
    super(Session);
  }

  /**
   * Find a session by user ID and message ID
   */
  async findByUserAndMessage(userId: number, messageId: number): Promise<ISession | null> {
    return await this.model.findOne({ userId, messageId });
  }

  /**
   * Find all active sessions for a user
   */
  async findByUser(userId: number): Promise<ISession[]> {
    return await this.model.find({
      userId,
      expiresAt: { $gt: new Date() },
    });
  }

  /**
   * Clean up expired sessions
   * Returns the number of sessions deleted
   */
  async cleanupExpired(): Promise<number> {
    const result = await this.model.deleteMany({
      expiresAt: { $lte: new Date() },
    });
    return result.deletedCount ?? 0;
  }

  /**
   * Update session state
   */
  async updateState(
    sessionId: string,
    state: string,
    updates: Partial<ISession>
  ): Promise<ISession | null> {
    return await this.model.findByIdAndUpdate(
      sessionId,
      {
        state,
        ...updates,
        updatedAt: new Date(),
      },
      { new: true }
    );
  }

  /**
   * Find sessions waiting for custom text input
   */
  async findWaitingForCustomText(userId: number): Promise<ISession | null> {
    return await this.model.findOne({
      userId,
      waitingForCustomText: true,
      expiresAt: { $gt: new Date() },
    });
  }
}
