import { Api } from 'grammy';
import { ScheduledPostRepository } from '../../database/repositories/scheduled-post.repository.js';
import { ChannelListRepository } from '../../database/repositories/channel-list.repository.js';
import { SessionRepository } from '../../database/repositories/session.repository.js';
import { PostPublisherService } from '../../core/posting/post-publisher.service.js';
import { PostWorkerService } from '../../services/post-worker.service.js';
import { PostSchedulerService } from '../../core/posting/post-scheduler.service.js';
import { TextTransformerService } from '../../core/transformation/text-transformer.service.js';
import { NicknameResolverService } from '../../core/attribution/nickname-resolver.service.js';
import { AttributionService } from '../../core/attribution/attribution.service.js';
import { TransformerService } from '../../services/transformer.service.js';
import { SessionService } from '../../core/session/session.service.js';
import { RetryService } from '../../utils/retry/retry.service.js';

/**
 * Dependency Injection Container
 * Manages service lifecycle and dependencies
 */
export class DIContainer {
  private static instances = new Map<string, unknown>();

  /**
   * Register a service instance
   */
  static register<T>(key: string, instance: T): void {
    this.instances.set(key, instance);
  }

  /**
   * Resolve a service instance
   */
  static resolve<T>(key: string): T {
    const instance = this.instances.get(key);
    if (!instance) {
      throw new Error(`No instance registered for key: ${key}`);
    }
    return instance as T;
  }

  /**
   * Check if a service is registered
   */
  static has(key: string): boolean {
    return this.instances.has(key);
  }

  /**
   * Initialize all services and repositories
   * Call this once during application startup
   */
  static initialize(api: Api): void {
    // Repositories
    const scheduledPostRepo = new ScheduledPostRepository();
    const channelListRepo = new ChannelListRepository();
    const sessionRepo = new SessionRepository();

    this.register('ScheduledPostRepository', scheduledPostRepo);
    this.register('ChannelListRepository', channelListRepo);
    this.register('SessionRepository', sessionRepo);

    // Core transformation services
    const textTransformer = new TextTransformerService();
    const nicknameResolver = new NicknameResolverService();
    const attribution = new AttributionService(nicknameResolver, channelListRepo);

    this.register('TextTransformerService', textTransformer);
    this.register('NicknameResolverService', nicknameResolver);
    this.register('AttributionService', attribution);

    // Transformer facade
    const transformerService = new TransformerService();
    this.register('TransformerService', transformerService);

    // Posting services
    const publisher = new PostPublisherService(api);
    const retryService = new RetryService();
    const postWorker = new PostWorkerService(api);
    const postScheduler = new PostSchedulerService();

    this.register('PostPublisherService', publisher);
    this.register('RetryService', retryService);
    this.register('PostWorkerService', postWorker);
    this.register('PostSchedulerService', postScheduler);

    // Session service
    const sessionService = new SessionService(sessionRepo);
    this.register('SessionService', sessionService);

    // Store API for direct access if needed
    this.register('Api', api);
  }

  /**
   * Clear all registered instances
   * Useful for testing
   */
  static clear(): void {
    this.instances.clear();
  }
}
