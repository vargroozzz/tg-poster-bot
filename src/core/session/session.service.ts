import type { Message } from 'grammy/types';
import { SessionRepository } from '../../database/repositories/session.repository.js';
import type { ISession } from '../../database/models/session.model.js';
import { SessionState } from '../../shared/constants/flow-states.js';
import { logger } from '../../utils/logger.js';

/**
 * Service for managing user sessions
 * Replaces in-memory pendingForwards Map with database-backed storage
 */
export class SessionService {
  // Session TTL: 24 hours
  private static readonly SESSION_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(private repository: SessionRepository) {}

  /**
   * Create a new session for a user message
   */
  async create(userId: number, message: Message): Promise<ISession> {
    const expiresAt = new Date(Date.now() + SessionService.SESSION_TTL_MS);

    const session = await this.repository.create({
      userId,
      messageId: message.message_id,
      chatId: message.chat.id,
      state: SessionState.CHANNEL_SELECT,
      originalMessage: message,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt,
    } as Partial<ISession>);

    logger.debug(`Created session ${session._id} for user ${userId}, message ${message.message_id}`);
    return session;
  }

  /**
   * Find a session by user ID and message ID
   */
  async findByMessage(userId: number, messageId: number): Promise<ISession | null> {
    return await this.repository.findByUserAndMessage(userId, messageId);
  }

  /**
   * Find a session by ID
   */
  async findById(sessionId: string): Promise<ISession | null> {
    return await this.repository.findById(sessionId);
  }

  /**
   * Update session state and data
   */
  async updateState(
    sessionId: string,
    newState: SessionState,
    updates: Partial<ISession>
  ): Promise<ISession | null> {
    const updated = await this.repository.updateState(sessionId, newState, updates);

    if (updated) {
      logger.debug(`Updated session ${sessionId} to state ${newState}`);
    }

    return updated;
  }

  /**
   * Update session data without changing state
   */
  async update(sessionId: string, updates: Partial<ISession>): Promise<ISession | null> {
    const session = await this.repository.findById(sessionId);
    if (!session) {
      return null;
    }

    return await this.repository.update(sessionId, {
      ...updates,
      updatedAt: new Date(),
    });
  }

  /**
   * Mark session as completed and delete it
   */
  async complete(sessionId: string): Promise<void> {
    await this.repository.delete(sessionId);
    logger.debug(`Completed and deleted session ${sessionId}`);
  }

  /**
   * Find session waiting for custom text input
   */
  async findWaitingForCustomText(userId: number): Promise<ISession | null> {
    return await this.repository.findWaitingForCustomText(userId);
  }

  /**
   * Clean up expired sessions
   * Returns number of sessions cleaned up
   */
  async cleanupExpired(): Promise<number> {
    const count = await this.repository.cleanupExpired();
    if (count > 0) {
      logger.info(`Cleaned up ${count} expired session(s)`);
    }
    return count;
  }

  /**
   * Get all active sessions for a user
   */
  async getActiveUserSessions(userId: number): Promise<ISession[]> {
    return await this.repository.findByUser(userId);
  }
}
