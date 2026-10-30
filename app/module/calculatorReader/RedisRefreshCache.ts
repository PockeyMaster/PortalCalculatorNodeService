import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import type { CalculatorLookup, ReaderChannel, ReaderSite } from './types';
import type { RefreshCache, RefreshGroup } from './CacheRefreshService';

export const REFRESH_RENEW = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end return redis.call('PEXPIRE',KEYS[1],ARGV[2])";
export const REFRESH_RELEASE = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end return redis.call('DEL',KEYS[1])";
export const REFRESH_WRITE = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[2],ARGV[2]) redis.call('HSET',KEYS[3],KEYS[2],ARGV[3]) return 1";
export const REFRESH_COMPLETE = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('HSET',KEYS[2],ARGV[2],ARGV[3]) return 1";

/** 元数据与数据均由同一个独立 Redis 实例管理；不是 Redis Cluster 客户端。 */
export class RedisRefreshCache implements RefreshCache {
  private readonly prefix: string;
  private readonly lock: string;
  private readonly versions: string;

  constructor(private readonly redis: Redis, site: ReaderSite, channel: ReaderChannel,
    private readonly connect: () => Promise<void>) {
    this.prefix = `PortalCalculatorNodeService:${channel === 'prod' ? 'v4' : 'gray'}:internal:refresh:${site}`;
    this.lock = `${this.prefix}:lock`;
    this.versions = `${this.prefix}:versions`;
  }

  private inventory(group: RefreshGroup): string {
    return `${this.prefix}:inventory:${createHash('sha256').update(group.id).digest('hex')}`;
  }

  async acquire(token: string, ttl: number): Promise<boolean> {
    await this.connect();
    return await this.redis.set(this.lock, token, 'PX', ttl, 'NX') === 'OK';
  }

  async renew(token: string, ttl: number): Promise<boolean> {
    return Number(await this.redis.eval(REFRESH_RENEW, 1, this.lock, token, ttl)) === 1;
  }

  async release(token: string): Promise<void> {
    await this.redis.eval(REFRESH_RELEASE, 1, this.lock, token);
  }

  async unchanged(group: RefreshGroup): Promise<boolean> {
    const body = await this.redis.hget(this.versions, group.id);
    if (!body) { return false; }
    let state: { version?: unknown; keys?: unknown };
    try { state = JSON.parse(body); } catch { return false; }
    if (!state || state.version !== group.version || !Array.isArray(state.keys) || state.keys.some(key => typeof key !== 'string')) { return false; }
    if (group.stableKey && !state.keys.includes(group.stableKey)) { return false; }
    const keys = state.keys as string[];
    if (!keys.length) { return true; }
    const pipeline = this.redis.pipeline();
    for (const key of keys) { pipeline.exists(key); }
    const results = await pipeline.exec();
    return results !== null && results.length === keys.length && results.every(([ error, exists ]) => !error && exists === 1);
  }

  async managed(group: RefreshGroup): Promise<CalculatorLookup[]> {
    const values = await this.redis.hvals(this.inventory(group));
    return values.map(value => JSON.parse(value) as CalculatorLookup);
  }

  async write(token: string, group: RefreshGroup, lookup: CalculatorLookup, body: string): Promise<boolean> {
    return Number(await this.redis.eval(REFRESH_WRITE, 3, this.lock, lookup.stableKey, this.inventory(group),
      token, body, JSON.stringify(lookup))) === 1;
  }

  async complete(token: string, group: RefreshGroup, keys: string[]): Promise<boolean> {
    return Number(await this.redis.eval(REFRESH_COMPLETE, 2, this.lock, this.versions,
      token, group.id, JSON.stringify({ version: group.version, keys }))) === 1;
  }
}
