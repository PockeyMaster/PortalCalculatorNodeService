import Redis from 'ioredis';
import { MongoClient } from 'mongodb';
import type { MongoClientOptions } from 'mongodb';
import { CalculatorReadService } from './CalculatorReadService';
import { MongoCurrentRepository } from './MongoCurrentRepository';
import { CacheRefreshService } from './CacheRefreshService';
import { RedisRefreshCache } from './RedisRefreshCache';
import { MongoRefreshSource } from './MongoRefreshSource';
import type { CalculatorReaderConfig, ReaderLogger } from './types';

export interface CalculatorReaderConnections {
  mongoUri: string;
  mongoDb: string;
  mongoOptions?: MongoClientOptions;
  redis?: { host: string; port: number; password?: string };
}

/** HTTP 仍然 Redis 优先；后台检查由 didReady 启动，不阻塞服务启动和存活探针。 */
export class CalculatorReaderRuntime {
  readonly service: CalculatorReadService;
  private readonly mongo: MongoClient;
  private readonly redis: Redis | undefined;
  private readonly refresher: CacheRefreshService | undefined;
  private redisConnecting: Promise<void> | undefined;

  constructor(private readonly config: CalculatorReaderConfig, connections: CalculatorReaderConnections,
    private readonly logger?: ReaderLogger) {
    this.mongo = new MongoClient(connections.mongoUri, { ...connections.mongoOptions, serverSelectionTimeoutMS: config.mongoTimeoutMs,
      connectTimeoutMS: config.mongoTimeoutMs, socketTimeoutMS: config.mongoTimeoutMs, maxPoolSize: 5 });
    if (connections.redis?.host) {
      this.redis = new Redis({ ...connections.redis, lazyConnect: true, enableOfflineQueue: false,
        connectTimeout: config.redisTimeoutMs, commandTimeout: config.redisTimeoutMs, maxRetriesPerRequest: 0,
        retryStrategy: attempt => Math.min(attempt * 1000, 10_000) });
      this.redis.on('error', () => { /* 不输出连接凭据，HTTP 与后台任务各自记录安全上下文。 */ });
    }
    const redis = { get: async (key: string) => {
      await this.ensureRedis();
      return this.redis!.get(key);
    } };
    this.service = new CalculatorReadService(redis, {
      read: async lookup => {
        await this.mongo.connect();
        return new MongoCurrentRepository(this.mongo.db(connections.mongoDb), config.mongoTimeoutMs).read(lookup);
      },
    }, config, logger);
    if (this.redis && config.refresh?.enabled !== false) {
      const source = new MongoRefreshSource(this.mongo.db(connections.mongoDb), config, () => this.mongo.connect());
      const cache = new RedisRefreshCache(this.redis, config.site, config.channel, () => this.ensureRedis());
      this.refresher = new CacheRefreshService(source, cache, config.refresh?.intervalMs ?? 60000, logger);
    }
  }

  startRefresh(): void {
    if (this.refresher) { this.refresher.start(); return; }
    this.logger?.info('[cache-refresh] disabled enabled=%s redisConfigured=%s', this.config.refresh?.enabled !== false, !!this.redis);
  }

  private async ensureRedis(): Promise<void> {
    if (!this.redis) { throw new Error('Reader Redis is not configured'); }
    if (this.redis.status === 'ready') { return; }
    if (this.redisConnecting) { return this.redisConnecting; }
    if (this.redis.status !== 'wait') { throw new Error('Reader Redis is not ready'); }
    this.redisConnecting = this.redis.connect().then(() => undefined).finally(() => { this.redisConnecting = undefined; });
    return this.redisConnecting;
  }

  async close(): Promise<void> {
    await this.refresher?.stop();
    this.redis?.disconnect();
    await this.mongo.close();
  }
}
