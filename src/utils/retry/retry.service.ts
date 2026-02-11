import { logger } from '../logger.js';
import type { IScheduledPost } from '../../database/models/scheduled-post.model.js';

/**
 * Configuration for retry behavior
 */
export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

/**
 * Metadata tracking retry attempts
 */
export interface RetryMetadata {
  attemptCount: number;
  lastAttemptAt?: Date;
  nextRetryAt?: Date;
  lastError?: string;
}

/**
 * Default retry configuration
 */
const DEFAULT_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000, // 1 second
  maxDelayMs: 60000, // 1 minute
  backoffMultiplier: 2,
  retryableErrors: [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    '429', // Rate limit
    'network',
    'timeout',
  ],
};

/**
 * Service to handle retry logic with exponential backoff
 */
export class RetryService {
  private config: RetryConfig;

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute an operation with retry logic
   * Uses exponential backoff for retries
   */
  async withRetry<T>(
    operation: () => Promise<T>,
    post: IScheduledPost,
    customConfig?: Partial<RetryConfig>
  ): Promise<T> {
    const config = { ...this.config, ...customConfig };
    const retryMetadata: RetryMetadata = post.retryMetadata ?? {
      attemptCount: 0,
    };

    let lastError: Error | undefined;

    while (retryMetadata.attemptCount < config.maxAttempts) {
      try {
        retryMetadata.attemptCount++;
        retryMetadata.lastAttemptAt = new Date();

        logger.debug(
          `Attempt ${retryMetadata.attemptCount}/${config.maxAttempts} for post ${post._id}`
        );

        const result = await operation();

        // Success - clear retry metadata
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retryMetadata.lastError = lastError.message;

        const isRetryable = this.isRetryableError(lastError, config);

        if (!isRetryable) {
          logger.warn(`Non-retryable error for post ${post._id}: ${lastError.message}`);
          throw lastError;
        }

        if (retryMetadata.attemptCount >= config.maxAttempts) {
          logger.error(
            `Max retry attempts (${config.maxAttempts}) reached for post ${post._id}`
          );
          throw lastError;
        }

        // Calculate next retry delay with exponential backoff
        const delayMs = this.calculateDelay(
          retryMetadata.attemptCount,
          config.initialDelayMs,
          config.maxDelayMs,
          config.backoffMultiplier
        );

        retryMetadata.nextRetryAt = new Date(Date.now() + delayMs);

        logger.info(
          `Retrying post ${post._id} in ${delayMs}ms (attempt ${retryMetadata.attemptCount}/${config.maxAttempts})`
        );

        // Update post with retry metadata
        await post.updateOne({ retryMetadata });

        // Wait before retry
        await this.sleep(delayMs);
      }
    }

    // Should not reach here, but throw last error if we do
    throw lastError ?? new Error('Unknown retry error');
  }

  /**
   * Check if an error is retryable based on configuration
   */
  private isRetryableError(error: Error, config: RetryConfig): boolean {
    const errorMessage = error.message.toLowerCase();
    const errorName = error.name.toLowerCase();

    return config.retryableErrors.some((retryableError) => {
      const pattern = retryableError.toLowerCase();
      return errorMessage.includes(pattern) || errorName.includes(pattern);
    });
  }

  /**
   * Calculate delay with exponential backoff
   */
  private calculateDelay(
    attemptCount: number,
    initialDelay: number,
    maxDelay: number,
    multiplier: number
  ): number {
    const delay = initialDelay * Math.pow(multiplier, attemptCount - 1);
    return Math.min(delay, maxDelay);
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
