import { Effect, Schedule, Duration } from 'effect';
import { logger } from '../logger.js';
import type { IScheduledPost } from '../../database/models/scheduled-post.model.js';

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

const DEFAULT_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
  retryableErrors: ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', '429', 'network', 'timeout'],
};

function isRetryableError(error: Error, config: RetryConfig): boolean {
  const msg = error.message.toLowerCase();
  const name = error.name.toLowerCase();
  return config.retryableErrors.some((p) => {
    const pattern = p.toLowerCase();
    return msg.includes(pattern) || name.includes(pattern);
  });
}

export function withRetry<T>(
  operation: () => Promise<T>,
  post: IScheduledPost,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const schedule = Schedule.exponential(
    Duration.millis(cfg.initialDelayMs),
    cfg.backoffMultiplier
  ).pipe(
    Schedule.upTo(Duration.millis(cfg.maxDelayMs)),
    Schedule.intersect(Schedule.recurs(cfg.maxAttempts - 1))
  );

  return Effect.runPromise(
    Effect.tryPromise({
      try: operation,
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }).pipe(
      Effect.tapError((error) => {
        if (!isRetryableError(error, cfg)) return Effect.void;
        logger.info(`Post ${post._id} will retry after: ${error.message}`);
        return Effect.promise(() =>
          post.updateOne({ retryMetadata: { lastAttemptAt: new Date(), lastError: error.message } })
        );
      }),
      Effect.retry(
        schedule.pipe(Schedule.whileInput((error: Error) => isRetryableError(error, cfg)))
      )
    )
  );
}
