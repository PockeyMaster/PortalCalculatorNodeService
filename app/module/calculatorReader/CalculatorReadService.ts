import { CalculatorKey } from './CalculatorKey';
import { CalculatorDataUnavailableError, CalculatorInputError, CalculatorNotFoundError } from './types';
import type { CalculatorLookup, CalculatorReaderConfig, CurrentReader, ReaderLanguage, ReaderLogger, RedisReader, ReaderTab } from './types';

function parameter(query: Record<string, unknown>, key: string, fallback?: string): string {
  const value = query[key] ?? fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[:\s]/.test(value.trim())) {
    throw new CalculatorInputError(`${key} is required and must be a valid string`);
  }
  if ([ ...value ].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new CalculatorInputError(`${key} must not contain control characters`);
  }
  return value.trim();
}
function service(query: Record<string, unknown>): string {
  if (query.urlPath !== undefined && query.urlPaht !== undefined && query.urlPath !== query.urlPaht) {
    throw new CalculatorInputError('urlPath and urlPaht must match');
  }
  const value = parameter({ urlPath: query.urlPath ?? query.urlPaht }, 'urlPath');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(value)) { throw new CalculatorInputError('Invalid urlPath'); }
  return value;
}
function language(query: Record<string, unknown>): ReaderLanguage {
  const value = parameter(query, 'language', 'zh-cn');
  if (value !== 'zh-cn' && value !== 'en-us' && value !== 'es-us') { throw new CalculatorInputError('Unsupported language'); }
  return value;
}
function sign(query: Record<string, unknown>): 'common' | 'cpq' {
  const value = parameter(query, 'sign', 'common');
  if (value !== 'common' && value !== 'cpq') { throw new CalculatorInputError('sign must be common or cpq'); }
  return value;
}

/** 不创建连接、不写缓存；移植时只需要提供 Redis/Mongo 的读取端口。 */
export class CalculatorReadService {
  constructor(private readonly redis: RedisReader, private readonly mongo: CurrentReader,
    private readonly config: CalculatorReaderConfig, private readonly logger?: ReaderLogger) {
    if (config.site !== 'zh-CN' && config.site !== 'zh-HK') { throw new CalculatorInputError('Invalid reader site'); }
    if (config.channel !== 'gray' && config.channel !== 'prod') { throw new CalculatorInputError('Invalid reader channel'); }
    if (!Number.isFinite(config.redisTimeoutMs) || config.redisTimeoutMs < 1) { throw new CalculatorInputError('Invalid Redis read timeout'); }
  }
  async configDocument(query: Record<string, unknown>): Promise<string> {
    const name = service(query);
    return this.read({ type: 'config', site: this.config.site, channel: this.config.channel,
      stableKey: CalculatorKey.config({ channel: this.config.channel, service: name, language: language(query) }) });
  }
  async menuInfo(query: Record<string, unknown>): Promise<unknown> {
    const body = await this.read({ type: 'menuInfo', site: this.config.site, channel: this.config.channel,
      stableKey: CalculatorKey.menuInfo({ channel: this.config.channel, sign: sign(query), language: language(query) }) });
    return JSON.parse(body);
  }
  async language(query: Record<string, unknown>): Promise<unknown> {
    const body = await this.read({ type: 'language', site: this.config.site, channel: this.config.channel,
      stableKey: CalculatorKey.language({ channel: this.config.channel, language: language(query) }) });
    return JSON.parse(body);
  }
  async productInfo(query: Record<string, unknown>): Promise<unknown> {
    const name = service(query);
    const tag = parameter(query, 'tag');
    const region = parameter(query, 'region');
    const tab = parameter(query, 'tab');
    if (tab !== 'calc' && tab !== 'detail' && tab !== 'listCalc') { throw new CalculatorInputError('tab must be calc, detail or listCalc'); }
    const body = await this.read({ type: 'productInfo', site: this.config.site, channel: this.config.channel,
      service: name, tag, region, tab: tab as ReaderTab,
      stableKey: CalculatorKey.productInfo({ channel: this.config.channel, service: name, tag, region, tab }) });
    return JSON.parse(body);
  }
  private valid(body: string, lookup: CalculatorLookup): boolean {
    if (lookup.type === 'config') { return body.trim().length > 0; }
    try {
      const value = JSON.parse(body);
      if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
      if (lookup.type === 'menuInfo' || lookup.type === 'language') { return true; }
      return matchesProductLookup(value, lookup);
    } catch { return false; }
  }
  private async read(lookup: CalculatorLookup): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const body = await Promise.race([
        this.redis.get(lookup.stableKey),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Redis read timed out')), this.config.redisTimeoutMs); }),
      ]);
      if (body !== null && this.valid(body, lookup)) { return body; }
      this.logger?.warn('[calculator-read] Mongo fallback site=%s channel=%s key=%s reason=%s',
        lookup.site, lookup.channel, lookup.stableKey, body === null ? 'redis-miss' : 'invalid-cache');
    } catch (error) {
      this.logger?.warn('[calculator-read] Mongo fallback site=%s channel=%s key=%s reason=redis-error error=%s',
        lookup.site, lookup.channel, lookup.stableKey, 'storage-error');
    } finally { if (timer) { clearTimeout(timer); } }
    let body: string | null;
    try { body = await this.mongo.read(lookup); } catch (error) {
      this.logger?.error('[calculator-read] Mongo failed site=%s channel=%s key=%s error=%s',
        lookup.site, lookup.channel, lookup.stableKey, 'storage-error');
      throw new CalculatorDataUnavailableError('Current calculator data is temporarily unavailable');
    }
    if (body === null) { throw new CalculatorNotFoundError('Current calculator data not found'); }
    if (!this.valid(body, lookup)) { throw new CalculatorDataUnavailableError('Invalid current calculator document'); }
    this.logger?.info('[calculator-read] Mongo fallback succeeded site=%s channel=%s key=%s', lookup.site, lookup.channel, lookup.stableKey);
    return body;
  }
}

/** productInfo 载荷必须与请求维度一一对应；仅 listCalc 的 product 是数组。 */
function matchesProductLookup(value: Record<string, unknown>, lookup: CalculatorLookup): boolean {
  return value.urlPath === lookup.service && value.tag === lookup.tag && value.region === lookup.region && value.tab === lookup.tab
    && value.product !== null && typeof value.product === 'object' && (lookup.tab === 'listCalc') === Array.isArray(value.product)
    && value.period !== null && typeof value.period === 'object' && !Array.isArray(value.period);
}
