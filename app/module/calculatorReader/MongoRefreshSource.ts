import type { Db } from 'mongodb';
import { CalculatorKey } from './CalculatorKey';
import { MongoCurrentRepository } from './MongoCurrentRepository';
import type { CalculatorLookup, CalculatorReaderConfig, ReaderDocumentType, ReaderTab } from './types';
import type { RefreshGroup, RefreshSource } from './CacheRefreshService';

interface ProductState { service: string; buildId: string; skuCount: number }
interface CompiledState { stableKey: string; buildId: string; sha256: string; type: ReaderDocumentType }
interface ProductBuild {
  _id: string;
  status: string;
  request: { channel: string; config: { service: string } };
  keys: string[];
  emptyImageTargets?: string[];
}
interface TargetDimensions { tag: string; region: string; tab: ReaderTab }

/** 版本检查仅投影元数据；只有变更/缓存缺失时才按当前版本读取 SKU 和完整配置。 */
export class MongoRefreshSource implements RefreshSource {
  private readonly prefix: string;
  private readonly reader: MongoCurrentRepository;

  constructor(private readonly db: Db, private readonly settings: CalculatorReaderConfig,
    private readonly connect: () => Promise<unknown>) {
    this.prefix = settings.site === 'zh-CN' ? 'calculator_cn' : 'calculator_intl';
    this.reader = new MongoCurrentRepository(db, settings.mongoTimeoutMs);
  }

  async list(): Promise<RefreshGroup[]> {
    await this.connect();
    const options = { maxTimeMS: this.settings.mongoTimeoutMs, readPreference: 'primary' as const };
    const [ products, compiled ] = await Promise.all([
      this.db.collection<ProductState>(`${this.prefix}_aggregate_current_states`).find({ channel: this.settings.channel },
        { ...options, projection: { service: 1, buildId: 1, skuCount: 1 } }).toArray(),
      this.db.collection<CompiledState>(`${this.prefix}_compiled_current_documents`).find({ channel: this.settings.channel },
        { ...options, projection: { stableKey: 1, buildId: 1, sha256: 1, type: 1 } }).toArray(),
    ]);
    const groups: RefreshGroup[] = products.map(row => {
      if (typeof row.buildId !== 'string' || !row.buildId || !/^[a-z0-9][a-z0-9_-]*$/i.test(row.service)) {
        throw new Error('Invalid current product metadata');
      }
      return { id: `productInfo:${row.service}`, version: row.buildId, type: 'productInfo', service: row.service };
    });
    for (const row of compiled) {
      if (![ 'config', 'menuInfo', 'language' ].includes(row.type) || !row.buildId || !row.sha256) { throw new Error('Invalid compiled metadata'); }
      const group: RefreshGroup = { id: `compiled:${row.stableKey}`, version: `${row.buildId}:${row.sha256}`, type: row.type, stableKey: row.stableKey };
      this.validateLookup(group, this.compiledLookup(group));
      groups.push(group);
    }
    const order = { productInfo: 0, config: 1, menuInfo: 2, language: 3 };
    return groups.sort((a, b) => order[a.type] - order[b.type] || a.id.localeCompare(b.id));
  }

  async targets(group: RefreshGroup): Promise<CalculatorLookup[]> {
    if (group.type !== 'productInfo') { return [ this.compiledLookup(group) ]; }
    const build = await this.db.collection<ProductBuild>(`${this.prefix}_aggregate_builds`).findOne({ _id: group.version },
      { maxTimeMS: this.settings.mongoTimeoutMs, readPreference: 'primary', projection: { status: 1, request: 1, keys: 1, emptyImageTargets: 1 } });
    if (!build || ![ 'ready', 'published' ].includes(build.status) || build.request?.channel !== this.settings.channel
      || build.request?.config?.service !== group.service || !Array.isArray(build.keys)) { throw new Error('Invalid product build metadata'); }
    const dimensions = await this.db.collection(`${this.prefix}_aggregated_skus`).aggregate<{ _id: TargetDimensions }>([
      { $match: { channel: this.settings.channel, service: group.service, buildId: group.version } },
      { $unwind: '$tabs' },
      { $group: { _id: { tag: '$productTag', region: '$region', tab: '$tabs' } } },
    ], { maxTimeMS: this.settings.mongoTimeoutMs, readPreference: 'primary' }).toArray();
    const selected = new Map<string, CalculatorLookup>();
    for (const { _id } of dimensions) { this.addTarget(group, selected, _id); }
    // 无 SKU 的免费镜像桶用构建元数据恢复，不依赖按下划线猜测 Redis Key 的各段。
    for (const target of build.emptyImageTargets ?? []) {
      const parts = target.split('\u0000');
      if (parts.length !== 3) { throw new Error('Invalid empty image target'); }
      this.addTarget(group, selected, { tag: parts[0], region: parts[1], tab: parts[2] as ReaderTab });
    }
    const keys = new Set(build.keys);
    if (keys.size !== selected.size || [ ...keys ].some(key => !selected.has(key))) { throw new Error('Product targets do not match the completed build'); }
    return [ ...selected.values() ];
  }

  private addTarget(group: RefreshGroup, selected: Map<string, CalculatorLookup>, dimensions: TargetDimensions): void {
    if (!dimensions || typeof dimensions.tag !== 'string' || typeof dimensions.region !== 'string'
      || ![ 'calc', 'detail', 'listCalc' ].includes(dimensions.tab)) { throw new Error('Invalid stored product dimensions'); }
    const lookup: CalculatorLookup = { type: 'productInfo', site: this.settings.site, channel: this.settings.channel,
      service: group.service, ...dimensions,
      stableKey: CalculatorKey.productInfo({ channel: this.settings.channel, service: group.service!, ...dimensions }) };
    this.validateLookup(group, lookup);
    selected.set(lookup.stableKey, lookup);
  }

  async read(group: RefreshGroup, lookup: CalculatorLookup): Promise<string | null> {
    this.validateLookup(group, lookup);
    return this.reader.readVersion(lookup, group.version);
  }

  async isCurrent(group: RefreshGroup): Promise<boolean> {
    if (group.type === 'productInfo') {
      const row = await this.db.collection<ProductState>(`${this.prefix}_aggregate_current_states`).findOne({
        channel: this.settings.channel, service: group.service,
      }, { maxTimeMS: this.settings.mongoTimeoutMs, readPreference: 'primary', projection: { buildId: 1 } });
      return row?.buildId === group.version;
    }
    const row = await this.db.collection<CompiledState>(`${this.prefix}_compiled_current_documents`).findOne({
      channel: this.settings.channel, stableKey: group.stableKey, type: group.type,
    }, { maxTimeMS: this.settings.mongoTimeoutMs, readPreference: 'primary', projection: { buildId: 1, sha256: 1 } });
    return !!row && `${row.buildId}:${row.sha256}` === group.version;
  }

  private compiledLookup(group: RefreshGroup): CalculatorLookup {
    const lookup: CalculatorLookup = { type: group.type, site: this.settings.site, channel: this.settings.channel, stableKey: group.stableKey! };
    this.validateLookup(group, lookup);
    return lookup;
  }

  private validateLookup(group: RefreshGroup, lookup: CalculatorLookup): void {
    if (!lookup || lookup.site !== this.settings.site || lookup.channel !== this.settings.channel || lookup.type !== group.type) {
      throw new Error('Refresh target scope mismatch');
    }
    if (group.type === 'productInfo') {
      if (lookup.service !== group.service || !lookup.service || !lookup.tag || !lookup.region
        || !lookup.tab || ![ 'calc', 'detail', 'listCalc' ].includes(lookup.tab)) { throw new Error('Invalid managed product target'); }
      const key = CalculatorKey.productInfo({ channel: lookup.channel, service: lookup.service, tag: lookup.tag, region: lookup.region, tab: lookup.tab });
      if (key !== lookup.stableKey) { throw new Error('Managed product key mismatch'); }
      return;
    }
    const namespace = this.settings.channel === 'prod' ? 'v4' : 'gray';
    const prefix = `PortalCalculatorNodeService:${namespace}:${group.type}:`;
    if (typeof lookup.stableKey !== 'string' || lookup.stableKey !== group.stableKey || !lookup.stableKey.startsWith(prefix)) {
      throw new Error('Invalid compiled refresh key');
    }
  }
}
