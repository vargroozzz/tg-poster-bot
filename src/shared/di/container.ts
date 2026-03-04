import { Api } from 'grammy';
import { ScheduledPostRepository } from '../../database/repositories/scheduled-post.repository.js';
import { ChannelListRepository } from '../../database/repositories/channel-list.repository.js';
import { SessionRepository } from '../../database/repositories/session.repository.js';
import { PostPublisherService } from '../../core/posting/post-publisher.service.js';
import { PostWorkerService } from '../../services/post-worker.service.js';
import { PostSchedulerService } from '../../core/posting/post-scheduler.service.js';
import { SessionService } from '../../core/session/session.service.js';

/**
 * Dependency Injection Container
 * Manages service lifecycle and dependencies
 */
export class DIContainer {
  private static instances = new Map<string, unknown>();

  static register<T>(key: string, instance: T): void {
    this.instances.set(key, instance);
  }

  static resolve<T>(key: string): T {
    const instance = this.instances.get(key);
    if (!instance) {
      throw new Error(`No instance registered for key: ${key}`);
    }
    return instance as T;
  }

  static has(key: string): boolean {
    return this.instances.has(key);
  }

  static initialize(api: Api): void {
    // Repositories
    const scheduledPostRepo = new ScheduledPostRepository();
    const channelListRepo = new ChannelListRepository();
    const sessionRepo = new SessionRepository();

    this.register('ScheduledPostRepository', scheduledPostRepo);
    this.register('ChannelListRepository', channelListRepo);
    this.register('SessionRepository', sessionRepo);

    // Posting services
    const publisher = new PostPublisherService(api);
    const postWorker = new PostWorkerService(api);
    const postScheduler = new PostSchedulerService();

    this.register('PostPublisherService', publisher);
    this.register('PostWorkerService', postWorker);
    this.register('PostSchedulerService', postScheduler);

    // Session service
    const sessionService = new SessionService(sessionRepo);
    this.register('SessionService', sessionService);

    // Store API for direct access if needed
    this.register('Api', api);
  }

  static clear(): void {
    this.instances.clear();
  }
}
