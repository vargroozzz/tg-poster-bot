import { describe, it, expect, vi } from 'vitest';
import { SessionService } from '../session.service.js';
import type { SessionRepository } from '../../../database/repositories/session.repository.js';
import type { ISession } from '../../../database/models/session.model.js';

describe('SessionService reply dedup', () => {
  it('sees a reply session started by the same update, and only that one', async () => {
    const sessions: Partial<ISession>[] = [];
    const repository = {
      deleteMany: vi.fn(async () => 0),
      create: vi.fn(async (data: Partial<ISession>) => {
        sessions.push(data);
        return { ...data, _id: 'id' };
      }),
      findOne: vi.fn(async (filter: Partial<ISession>) =>
        sessions.find((s) => s.userId === filter.userId && s.replyTriggerUpdateId === filter.replyTriggerUpdateId) ??
        null
      ),
    } as unknown as SessionRepository;
    const service = new SessionService(repository);

    await service.createForReply(1, { replyParentPostId: 'p', replyTriggerUpdateId: 42 });

    expect(await service.replyStartedBy(1, 42)).toBe(true);
    expect(await service.replyStartedBy(1, 43)).toBe(false);
    expect(await service.replyStartedBy(2, 42)).toBe(false);
  });
});
