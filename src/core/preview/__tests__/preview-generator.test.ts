import { describe, it, expect } from 'vitest';
import { PreviewGeneratorService } from '../preview-generator.service.js';
import type { ISession } from '../../../database/models/session.model.js';

describe('PreviewGeneratorService — edit session', () => {
  const service = new PreviewGeneratorService();

  it('returns rawContent unchanged for forward action', async () => {
    const session = {
      _id: 'sess1',
      editingPostId: 'post1',
      selectedAction: 'forward',
      editingRawContent: { type: 'text', text: 'Original text' },
      editingOriginalForward: { chatId: -1001, messageId: 99 },
      textHandling: 'keep',
    } as unknown as ISession;

    const result = await service.generatePreview(session);
    expect(result).toEqual({ type: 'text', text: 'Original text' });
  });

  it('throws when editingRawContent is missing', async () => {
    const session = {
      _id: 'sess2',
      editingPostId: 'post2',
      selectedAction: 'transform',
      // editingRawContent intentionally omitted
      editingOriginalForward: { chatId: -1001, messageId: 99 },
    } as unknown as ISession;

    await expect(service.generatePreview(session)).rejects.toThrow('no editingRawContent');
  });
});
