import { HttpError, type Transformer } from 'grammy';
import { logger } from '../utils/logger.js';

// Only deletes: retrying is safe because a delete that already went through just fails as
// "not found" the second time. A send retried after a dropped response could post twice.
const RETRIED_METHODS = new Set(['deleteMessage', 'deleteMessages']);
export const DELETE_RETRY_DELAY_MS = 1000;
// Only a fast failure (reset, DNS) is retried: a stalled request already ate the time a webhook
// update has (10s), and retrying it would push the handler past it into Telegram's redelivery.
export const FAST_FAILURE_MS = 3000;
const ALREADY_DELETED = /message to delete not found/i;

/** Retries a delete once, after a short pause, when the request fails fast on the network. */
export const retryDeletesOnNetworkError: Transformer = async (prev, method, payload, signal) => {
  const started = Date.now();
  try {
    return await prev(method, payload, signal);
  } catch (error) {
    const retriable =
      error instanceof HttpError &&
      RETRIED_METHODS.has(method) &&
      Date.now() - started < FAST_FAILURE_MS &&
      !signal?.aborted;
    if (!retriable) throw error;
    logger.warn(`${method} failed on the network, retrying once: ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, DELETE_RETRY_DELAY_MS));
    const retried = await prev(method, payload, signal);
    // The first request went through and only its response was lost: the caller's "failed to
    // delete" warning that follows is about a message that is already gone.
    if (!retried.ok && ALREADY_DELETED.test(retried.description)) logger.info(`${method}: the first try had deleted it`);
    return retried;
  }
};
