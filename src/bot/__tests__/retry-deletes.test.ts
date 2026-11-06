import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpError } from 'grammy';

vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

const { retryDeletesOnNetworkError, FAST_FAILURE_MS } = await import('../retry-deletes.js');

type Prev = Parameters<typeof retryDeletesOnNetworkError>[0];
const OK = { ok: true, result: true };
const networkError = () => new HttpError('Network request failed', new Error('reset'));
const run = (prev: ReturnType<typeof vi.fn>, method: string, signal?: AbortSignal) => {
  const result = retryDeletesOnNetworkError(prev as unknown as Prev, method as Parameters<Prev>[0], {}, signal);
  // Settle before advancing timers, so a rejection isn't reported as unhandled.
  result.catch(() => {});
  return result;
};

describe('retryDeletesOnNetworkError', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(['deleteMessage', 'deleteMessages'])('retries %s once after a fast network error', async (method) => {
    const prev = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValue(OK);
    const result = run(prev, method);
    await vi.runAllTimersAsync();
    expect(await result).toEqual(OK);
    expect(prev).toHaveBeenCalledTimes(2);
  });

  it('gives up after the one retry', async () => {
    const prev = vi.fn().mockRejectedValue(networkError());
    const result = run(prev, 'deleteMessage');
    await vi.runAllTimersAsync();
    await expect(result).rejects.toBeInstanceOf(HttpError);
    expect(prev).toHaveBeenCalledTimes(2);
  });

  it('does not retry a request that stalled before failing', async () => {
    const prev = vi.fn().mockImplementation(async () => {
      vi.advanceTimersByTime(FAST_FAILURE_MS);
      throw networkError();
    });
    await expect(run(prev, 'deleteMessage')).rejects.toBeInstanceOf(HttpError);
    expect(prev).toHaveBeenCalledTimes(1);
  });

  it('does not retry once the caller aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const prev = vi.fn().mockRejectedValue(networkError());
    await expect(run(prev, 'deleteMessage', controller.signal)).rejects.toBeInstanceOf(HttpError);
    expect(prev).toHaveBeenCalledTimes(1);
  });

  it('never retries a send, which could post twice', async () => {
    const prev = vi.fn().mockRejectedValue(networkError());
    await expect(run(prev, 'sendMessage')).rejects.toBeInstanceOf(HttpError);
    expect(prev).toHaveBeenCalledTimes(1);
  });

  // Telegram's refusals come back as an ok: false response, not a throw, inside the chain.
  it('passes an API refusal through without retrying', async () => {
    const refusal = { ok: false, error_code: 400, description: "Bad Request: message can't be deleted" };
    const prev = vi.fn().mockResolvedValue(refusal);
    expect(await run(prev, 'deleteMessage')).toEqual(refusal);
    expect(prev).toHaveBeenCalledTimes(1);
  });
});
