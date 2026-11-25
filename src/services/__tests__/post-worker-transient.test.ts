import { describe, it, expect, vi } from 'vitest';
import { GrammyError, HttpError } from 'grammy';

vi.mock('../../config/index.js', () => ({ config: {} }));
vi.mock('../../utils/logger.js', () => ({ logger: {} }));

const { isTransient } = await import('../post-worker.service.js');

const apiError = (code: number) =>
  new GrammyError('call failed', { ok: false, error_code: code, description: 'x' }, 'sendVideo', {});

describe('isTransient', () => {
  it('retries network failures and rate limits', () => {
    expect(isTransient(new HttpError("Network request for 'sendVideo' failed!", new Error('ETIMEDOUT')))).toBe(true);
    expect(isTransient(apiError(429))).toBe(true);
  });

  it('gives up on errors Telegram rejected for good', () => {
    expect(isTransient(apiError(400))).toBe(false);
    expect(isTransient(apiError(403))).toBe(false);
    expect(isTransient(new Error('boom'))).toBe(false);
  });
});
