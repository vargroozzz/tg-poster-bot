import { Api } from 'grammy';
import { ScheduledPostRepository } from '../../database/repositories/scheduled-post.repository.js';
import { ChannelListRepository } from '../../database/repositories/channel-list.repository.js';
import { SessionRepository } from '../../database/repositories/session.repository.js';
import { PostPublisherService } from '../../core/posting/post-publisher.service.js';
import { PostWorkerService } from '../../services/post-worker.service.js';
import { PostSchedulerService } from '../../core/posting/post-scheduler.service.js';
import { SessionService } from '../../core/session/session.service.js';

export type ServiceRegistry = {
  ScheduledPostRepository: ScheduledPostRepository;
  ChannelListRepository: ChannelListRepository;
  SessionRepository: SessionRepository;
  PostPublisherService: PostPublisherService;
  PostWorkerService: PostWorkerService;
  PostSchedulerService: PostSchedulerService;
  SessionService: SessionService;
  Api: Api;
};

export class DIContainer {
  private static instances = new Map<keyof ServiceRegistry, unknown>();

  static register<K extends keyof ServiceRegistry>(key: K, instance: ServiceRegistry[K]): void {
    this.instances.set(key, instance);
  }

  static resolve<K extends keyof ServiceRegistry>(key: K): ServiceRegistry[K] {
    const instance = this.instances.get(key);
    if (!instance) {
      throw new Error(`No instance registered for key: ${key}`);
    }
    return instance as ServiceRegistry[K];
  }

  static has(key: keyof ServiceRegistry): boolean {
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
