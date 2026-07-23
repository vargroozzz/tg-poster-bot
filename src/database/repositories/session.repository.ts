import { BaseRepository } from './base.repository.js';
import { Session, type ISession } from '../models/session.model.js';
import { SessionState } from '../../shared/constants/flow-states.js';

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
    state: SessionState,
    updates: Partial<ISession>
  ): Promise<ISession | null> {
    // Mongoose drops undefined values from an update, so an explicit `field: undefined`
    // (how the flow resets a selection) has to be turned into a $unset to take effect.
    const entries = Object.entries(updates);
    const unset = Object.fromEntries(
      entries.filter(([, value]) => value === undefined).map(([key]) => [key, ''])
    );

    return await this.model.findByIdAndUpdate(
      sessionId,
      {
        $set: {
          ...Object.fromEntries(entries.filter(([, value]) => value !== undefined)),
          state,
          updatedAt: new Date(),
        },
        ...(Object.keys(unset).length > 0 && { $unset: unset }),
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

  async findWaitingForReplyContent(userId: number): Promise<ISession | null> {
    return await this.model.findOne({
      userId,
      state: SessionState.WAITING_FOR_REPLY_CONTENT,
      expiresAt: { $gt: new Date() },
    });
  }

  /**
   * Count a user's proposals awaiting owner action (handed off, still in PREVIEW).
   */
  async countPendingProposals(userId: number): Promise<number> {
    return await this.model.countDocuments({
      userId,
      proposalPending: true,
      state: SessionState.PREVIEW,
      expiresAt: { $gt: new Date() },
    });
  }
}
