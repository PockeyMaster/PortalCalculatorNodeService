import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { decodePublishedSku, indexPublishedPeriods, publishedListCalcDocument, READER_IMAGE_BUCKET } from './ProductDocumentCodec';
import type { CalculatorLookup, CurrentReader, ReaderObject, ReaderProductDocument } from './types';

interface CurrentState {
  site: string;
  channel: string;
  service: string;
  buildId: string;
  skuCount: number;
}
interface CurrentBuild {
  _id: string;
  status: string;
  skuCount: number;
  request: { channel: string; config: { service: string } };
  keys: string[];
  emptyImageTargets?: string[];
}
interface CompiledRecord {
  buildId: string;
  type: string;
  document: unknown;
  sha256: string;
  byteLength: number;
}

/** 只读当前数据：对外只接收业务参数/固定 Key，内部隐藏版本选择。 */
export class MongoCurrentRepository implements CurrentReader {
  constructor(private readonly db: Db, private readonly timeoutMs = 5000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) { throw new TypeError('Invalid Mongo read timeout'); }
  }

  async read(lookup: CalculatorLookup): Promise<string | null> {
    return this.readVersion(lookup);
  }

  /** 后台刷新固定本轮期望版本，版本变化必须重试，不能把新数据记到旧版本标记上。 */
  async readVersion(lookup: CalculatorLookup, expectedVersion?: string): Promise<string | null> {
    if (lookup.site !== 'zh-CN' && lookup.site !== 'zh-HK') { throw new TypeError('Unsupported reader site'); }
    const prefix = lookup.site === 'zh-CN' ? 'calculator_cn' : 'calculator_intl';
    if (lookup.type === 'productInfo') { return this.product(lookup, prefix, expectedVersion); }
    const row = await this.db.collection<CompiledRecord>(`${prefix}_compiled_current_documents`).findOne({
      stableKey: lookup.stableKey, channel: lookup.channel, site: lookup.site, type: lookup.type,
    }, this.readOptions(expectedVersion));
    if (!row) { return null; }
    if (expectedVersion !== undefined && expectedVersion !== row.buildId + ':' + row.sha256) {
      throw new Error('Compiled source version changed during refresh');
    }
    const body = this.compiledBody(lookup, row);
    // 摘要由管理面写入。坏数据返回不可用，不能恢复旧快照或当作缓存命中。
    if (typeof row.sha256 !== 'string' || row.byteLength !== Buffer.byteLength(body)
      || createHash('sha256').update(body).digest('hex') !== row.sha256) {
      throw new Error('Current compiled document checksum mismatch');
    }
    return body;
  }

  private readOptions(expectedVersion?: string) {
    // 后台版本检查和内容读取统一走主节点，避免 URI 的 secondary 偏好造成版本倒退。
    return { maxTimeMS: this.timeoutMs, ...(expectedVersion === undefined ? {} : { readPreference: 'primary' as const }) };
  }

  private compiledBody(lookup: CalculatorLookup, row: CompiledRecord): string {
    if (lookup.type === 'config') {
      if (typeof row.document !== 'string' || !row.document.trim()) { throw new Error('Current config is not JavaScript text'); }
      return row.document;
    }
    if (!row.document || typeof row.document !== 'object' || Array.isArray(row.document)) {
      throw new Error('Invalid current compiled JSON document');
    }
    return JSON.stringify(row.document);
  }

  private async product(lookup: CalculatorLookup, prefix: string, expectedVersion?: string): Promise<string | null> {
    const { service, tag, region, tab } = lookup;
    if (!service || !tag || !region || !tab) { throw new Error('Missing productInfo dimensions'); }
    const current = await this.db.collection<CurrentState>(`${prefix}_aggregate_current_states`).findOne({
      channel: lookup.channel, service,
    }, this.readOptions(expectedVersion));
    if (!current) { return null; }
    if (expectedVersion !== undefined && expectedVersion !== current.buildId) {
      throw new Error('Product source version changed during refresh');
    }
    if (current.site !== lookup.site || current.channel !== lookup.channel || current.service !== service
      || typeof current.buildId !== 'string' || !current.buildId || !Number.isSafeInteger(current.skuCount) || current.skuCount < 0) {
      throw new Error('Invalid current product pointer');
    }
    const build = await this.db.collection<CurrentBuild>(`${prefix}_aggregate_builds`).findOne({ _id: current.buildId }, {
      projection: { status: 1, skuCount: 1, request: 1, keys: 1, emptyImageTargets: 1 }, ...this.readOptions(expectedVersion),
    });
    this.validateBuild(build, current);
    const empty: ReaderProductDocument = { urlPath: service, tag, region, tab, product: {}, period: {} };
    // 不在当前版本的 Key 代表已移除的地域/标签/页面，返回合法空文档，不复活历史规格。
    if (current.skuCount === 0 || !build.keys.includes(lookup.stableKey)) { return this.serializeProduct(empty); }
    const product = await this.rows(lookup, prefix, current.buildId, expectedVersion);
    const target = `${tag}\u0000${region}\u0000${tab}`;
    if (build.emptyImageTargets?.includes(target)) { product[READER_IMAGE_BUCKET] ??= []; }
    if (!Object.keys(product).length) { throw new Error('Current product rows are missing'); }
    return this.serializeProduct({ ...indexPublishedPeriods({ product, period: {} }), urlPath: service, tag, region, tab });
  }

  private validateBuild(build: CurrentBuild | null, current: CurrentState): asserts build is CurrentBuild {
    if (!build || ![ 'ready', 'published' ].includes(build.status) || build.request?.channel !== current.channel
      || build.request?.config?.service !== current.service || build.skuCount !== current.skuCount || !Array.isArray(build.keys)) {
      throw new Error('Current product build is incomplete or inconsistent');
    }
  }

  private serializeProduct(document: ReaderProductDocument): string {
    return JSON.stringify(document.tab === 'listCalc' ? publishedListCalcDocument(document) : document);
  }

  private async rows(lookup: CalculatorLookup, prefix: string, buildId: string, expectedVersion?: string): Promise<Record<string, ReaderObject[]>> {
    const cursor = this.db.collection<ReaderObject>(`${prefix}_aggregated_skus`).find({
      channel: lookup.channel, service: lookup.service, buildId,
      productTag: lookup.tag, region: lookup.region, tabs: lookup.tab,
    }, this.readOptions(expectedVersion)).sort({ bucket: 1, resourceSpecCode: 1, locationType: 1, locationCode: 1 }).batchSize(500);
    const product: Record<string, ReaderObject[]> = {};
    try {
      for await (const row of cursor) {
        const bucket = row.bucket;
        if (typeof bucket !== 'string' || !bucket || [ '__proto__', 'constructor', 'prototype' ].includes(bucket)) {
          throw new Error('Invalid current product bucket');
        }
        (product[bucket] ??= []).push(decodePublishedSku(row));
      }
    } finally { await cursor.close(); }
    return product;
  }
}
