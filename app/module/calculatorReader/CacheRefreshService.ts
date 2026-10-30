import { randomUUID } from 'node:crypto';
import type { CalculatorLookup, ReaderLogger } from './types';

export interface RefreshGroup {
  id: string;
  version: string;
  type: 'productInfo' | 'config' | 'menuInfo' | 'language';
  service?: string;
  stableKey?: string;
}
export interface RefreshSource {
  list(): Promise<RefreshGroup[]>;
  targets(group: RefreshGroup): Promise<CalculatorLookup[]>;
  read(group: RefreshGroup, lookup: CalculatorLookup): Promise<string | null>;
  isCurrent(group: RefreshGroup): Promise<boolean>;
}
export interface RefreshCache {
  acquire(token: string, ttl: number): Promise<boolean>;
  renew(token: string, ttl: number): Promise<boolean>;
  release(token: string): Promise<void>;
  unchanged(group: RefreshGroup): Promise<boolean>;
  managed(group: RefreshGroup): Promise<CalculatorLookup[]>;
  write(token: string, group: RefreshGroup, lookup: CalculatorLookup, body: string): Promise<boolean>;
  complete(token: string, group: RefreshGroup, keys: string[]): Promise<boolean>;
}

class RefreshLeaseLostError extends Error {}

/** 只在后台写缓存。单进程不重入，多实例通过 Redis 租约及写入端令牌校验隔离。 */
export class CacheRefreshService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopping = false;
  private readonly leaseMs = 30000;

  constructor(private readonly source: RefreshSource, private readonly cache: RefreshCache,
    private readonly intervalMs = 60000, private readonly logger?: ReaderLogger) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2147483647) {
      throw new TypeError('Refresh interval must be a positive timer interval in milliseconds');
    }
  }

  start(): void {
    if (this.timer || this.stopping) { return; }
    this.logger?.info('[cache-refresh] scheduled intervalMs=%d firstRun=after-interval', this.intervalMs);
    this.timer = setInterval(() => { void this.run(); }, this.intervalMs);
    this.timer.unref();
  }

  run(): Promise<void> {
    if (this.stopping) { return Promise.resolve(); }
    if (this.running) { return this.running; }
    this.running = this.round().finally(() => { this.running = undefined; });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await this.running;
  }

  private async round(): Promise<void> {
    const token = randomUUID();
    let acquired = false;
    let held = false;
    let renewing = false;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let renewalTask: Promise<void> | undefined;
    const started = Date.now();
    try {
      acquired = await this.cache.acquire(token, this.leaseMs);
      if (!acquired) { return; }
      held = true;
      renewal = setInterval(() => {
        if (renewing || !held) { return; }
        renewing = true;
        renewalTask = this.cache.renew(token, this.leaseMs).then(value => { held = value; }, () => { held = false; })
          .finally(() => { renewing = false; });
      }, this.leaseMs / 3);
      renewal.unref();
      const groups = await this.source.list();
      let changed = 0;
      let failed = 0;
      for (const group of groups) {
        if (this.stopping || !held) { break; }
        try {
          if (await this.refresh(token, group, () => held)) { changed++; }
        } catch (error) {
          if (error instanceof RefreshLeaseLostError) { held = false; break; }
          failed++;
          // 原始驱动异常可能带地址/凭据；只记录范围，不输出异常文本或数据内容。
          this.logger?.error('[cache-refresh] group failed id=%s type=%s; version marker not advanced, retry pending', group.id, group.type);
        }
      }
      this.logger?.info('[cache-refresh] checked=%d changed=%d failed=%d leaseHeld=%s durationMs=%d',
        groups.length, changed, failed, held, Date.now() - started);
    } catch {
      this.logger?.error('[cache-refresh] round failed; check Mongo/Redis availability; existing cache preserved');
    } finally {
      if (renewal) { clearInterval(renewal); }
      await renewalTask;
      if (acquired) {
        try { await this.cache.release(token); } catch { /* 租约最终会自动过期，不能无条件 DEL 他人的锁。 */ }
      }
    }
  }

  private async refresh(token: string, group: RefreshGroup, held: () => boolean): Promise<boolean> {
    if (await this.cache.unchanged(group)) { return false; }
    const targets = await this.source.targets(group);
    const previous = await this.cache.managed(group);
    const all = new Map([ ...previous, ...targets ].map(target => [ target.stableKey, target ]));
    for (const lookup of all.values()) {
      if (this.stopping) { return false; }
      if (!held()) { throw new RefreshLeaseLostError(); }
      const body = await this.source.read(group, lookup);
      if (body === null || !await this.source.isCurrent(group)) { throw new Error('Source version changed or disappeared'); }
      // Lua 在写入时再次验证锁所有权，旧进程即使恢复也不能覆写新持锁者的数据。
      if (!await this.cache.write(token, group, lookup, body)) { throw new RefreshLeaseLostError(); }
    }
    if (this.stopping) { return false; }
    if (!held()) { throw new RefreshLeaseLostError(); }
    if (!await this.source.isCurrent(group)) { throw new Error('Source version changed'); }
    if (!await this.cache.complete(token, group, targets.map(target => target.stableKey))) { throw new RefreshLeaseLostError(); }
    this.logger?.info('[cache-refresh] refreshed id=%s keys=%d retired=%d', group.id, targets.length, all.size - targets.length);
    return true;
  }
}
