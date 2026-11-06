import assert from 'node:assert/strict';
import type { Db } from 'mongodb';
import { MongoCurrentRepository } from '../../../../app/module/calculatorReader/MongoCurrentRepository';
import { MongoRefreshSource } from '../../../../app/module/calculatorReader/MongoRefreshSource';
import { CacheRefreshService } from '../../../../app/module/calculatorReader/CacheRefreshService';
import type { RefreshGroup } from '../../../../app/module/calculatorReader/CacheRefreshService';
import { CalculatorReadService } from '../../../../app/module/calculatorReader/CalculatorReadService';
import { CalculatorKey } from '../../../../app/module/calculatorReader/CalculatorKey';
import type { CalculatorReaderConfig, ReaderObject } from '../../../../app/module/calculatorReader/types';
import { redisRefreshFixture } from './RedisRefreshCache.test';

const prefix = 'calculator_cn_';
const settings: CalculatorReaderConfig = { site: 'zh-CN', channel: 'gray', mongoTimeoutMs: 1000, redisTimeoutMs: 100 };
const tag = 'general.online.portal';
const instances: CacheRefreshService[] = [];

function key(region: string): string {
  return CalculatorKey.productInfo({ channel: 'gray', service: 'ecs', tag, region, tab: 'calc' });
}
function group(version: string): RefreshGroup {
  return { id: 'productInfo:ecs', type: 'productInfo', service: 'ecs', version };
}
function matches(row: ReaderObject, filter: ReaderObject): boolean {
  return Object.entries(filter).every(([ field, expected ]) => {
    const value = row[field];
    return Array.isArray(value) ? value.includes(expected) : value === expected;
  });
}

/** 串联真实读取/调度/Redis 适配器，存储替身只提供驱动协议，不提供刷新业务逻辑。 */
function fixture() {
  let pointer: ReaderObject | null = null;
  const builds = new Map<string, ReaderObject>();
  const snapshots: ReaderObject[] = [];
  const queries: string[] = [];
  const controls = { failRows: false, afterRows: undefined as (() => void) | undefined };
  function rows(name: string, filter: ReaderObject): ReaderObject[] {
    if (name === prefix + 'aggregate_current_states') { return pointer && matches(pointer, filter) ? [ pointer ] : []; }
    if (name === prefix + 'compiled_current_documents') { return []; }
    assert.equal(name, prefix + 'aggregate_build_skus');
    return snapshots.filter(row => matches(row, filter));
  }
  const db = { collection(name: string) {
    queries.push(name);
    assert.ok([ 'aggregate_current_states', 'aggregate_builds', 'aggregate_build_skus', 'compiled_current_documents' ]
      .some(suffix => name === prefix + suffix), 'the SKU view must never be queried');
    return {
      async findOne(filter: ReaderObject) {
        if (name === prefix + 'aggregate_builds') { return builds.get(String(filter._id)) ?? null; }
        return rows(name, filter)[0] ?? null;
      },
      find(filter: ReaderObject) {
        if (name === prefix + 'aggregate_build_skus' && controls.failRows) { throw new Error('simulated SKU read failure'); }
        const selected = rows(name, filter);
        return {
          sort() { return this; }, batchSize() { return this; }, async toArray() { return selected; },
          async close() { /* no network cursor */ },
          async* [Symbol.asyncIterator]() {
            yield* selected;
            const hook = controls.afterRows;
            controls.afterRows = undefined;
            hook?.();
          },
        };
      },
      aggregate(pipeline: ReaderObject[]) {
        assert.equal(name, prefix + 'aggregate_build_skus');
        const match = pipeline[0].$match as ReaderObject;
        assert.equal(typeof match.buildId, 'string', 'target discovery must be pinned to one snapshot');
        const dimensions = new Map<string, ReaderObject>();
        for (const row of rows(name, match)) {
          for (const tab of row.tabs as string[]) {
            const value = { tag: row.productTag, region: row.region, tab };
            dimensions.set(JSON.stringify(value), { _id: value });
          }
        }
        return { async toArray() { return [ ...dimensions.values() ]; } };
      },
    };
  } } as unknown as Db;
  function seed(version: string, regions: string[], amount: number): void {
    builds.set(version, { _id: version, status: 'ready', skuCount: regions.length,
      request: { channel: 'gray', config: { service: 'ecs' } }, keys: regions.map(key) });
    for (const region of regions) {
      snapshots.push({ buildId: version, service: 'ecs', productTag: tag, region, tabs: [ 'calc' ], bucket: 'ec2_vm',
        resourceType: 'hws.resource.type.vm', cloudServiceType: 'hws.service.type.ec2', resourceSpecCode: 'spec',
        planList: [{ billingMode: 'ONDEMAND', amount }], periodList: [], attributes: { cpu: '2' }, skuInfo: [] });
    }
  }
  function activate(version: string): void {
    const build = builds.get(version)!;
    pointer = { site: 'zh-CN', channel: 'gray', service: 'ecs', buildId: version, skuCount: build.skuCount };
  }
  const redis = redisRefreshFixture();
  const source = new MongoRefreshSource(db, settings, async () => undefined);
  const job = new CacheRefreshService(source, redis.cache);
  instances.push(job);
  const reader = new CalculatorReadService({ async get(stableKey) { return redis.values.get(stableKey) ?? null; } },
    new MongoCurrentRepository(db, 1000), settings);
  async function read(region: string): Promise<any> {
    return reader.productInfo({ urlPath: 'ecs', tag, region, tab: 'calc' });
  }
  function cached(region: string): any { return JSON.parse(redis.values.get(key(region))!); }
  return { seed, activate, redis, source, job, queries, controls, read, cached };
}

describe('current snapshot to Redis refresh chain', () => {
  afterEach(async () => { await Promise.all(instances.splice(0).map(instance => instance.stop())); });

  it('falls back directly to the current snapshot and refreshes prices when the pointer changes', async () => {
    const f = fixture();
    f.seed('v1', [ 'region-a' ], 1);
    f.activate('v1');
    assert.equal((await f.read('region-a')).product.ec2_vm[0].planList[0].amount, 1);
    assert.equal(f.redis.values.has(key('region-a')), false, 'HTTP fallback must not publish');
    await f.job.run();
    assert.equal(f.cached('region-a').product.ec2_vm[0].planList[0].amount, 1);
    assert.equal(await f.redis.cache.unchanged(group('v1')), true);
    f.seed('v2', [ 'region-a' ], 2);
    f.activate('v2');
    assert.equal((await f.read('region-a')).product.ec2_vm[0].planList[0].amount, 1, 'existing cache is refreshed by the next background round');
    await f.job.run();
    assert.equal((await f.read('region-a')).product.ec2_vm[0].planList[0].amount, 2);
    assert.equal(await f.redis.cache.unchanged(group('v2')), true);
    assert.ok(f.queries.every(name => !name.endsWith('_aggregated_skus')));
  });

  it('fills new region keys and empties retired regions and a completely empty generation', async () => {
    const f = fixture();
    f.seed('v1', [ 'region-a', 'region-b' ], 1);
    f.activate('v1');
    await f.job.run();
    f.seed('v2', [ 'region-a', 'region-c' ], 2);
    f.activate('v2');
    await f.job.run();
    assert.equal(f.cached('region-c').product.ec2_vm[0].planList[0].amount, 2);
    assert.deepEqual(f.cached('region-b').product, {});
    f.seed('empty', [], 0);
    f.activate('empty');
    await f.job.run();
    for (const region of [ 'region-a', 'region-b', 'region-c' ]) { assert.deepEqual(f.cached(region).product, {}); }
    assert.equal(await f.redis.cache.unchanged(group('empty')), true);
  });

  it('retains the old cache and completion version on read failure and succeeds on retry', async () => {
    const f = fixture();
    f.seed('v1', [ 'region-a' ], 1);
    f.activate('v1');
    await f.job.run();
    f.seed('v2', [ 'region-a' ], 2);
    f.activate('v2');
    f.controls.failRows = true;
    await f.job.run();
    assert.equal(f.cached('region-a').product.ec2_vm[0].planList[0].amount, 1);
    assert.equal(await f.redis.cache.unchanged(group('v1')), true);
    assert.equal(await f.redis.cache.unchanged(group('v2')), false);
    f.controls.failRows = false;
    await f.job.run();
    assert.equal(f.cached('region-a').product.ec2_vm[0].planList[0].amount, 2);
    assert.equal(await f.redis.cache.unchanged(group('v2')), true);
  });

  it('retries if the pointer changes while rendering instead of publishing a stale version', async () => {
    const f = fixture();
    f.seed('v1', [ 'region-a' ], 1);
    f.activate('v1');
    await f.job.run();
    f.seed('v2', [ 'region-a' ], 2);
    f.seed('v3', [ 'region-a' ], 3);
    f.activate('v2');
    f.controls.afterRows = () => f.activate('v3');
    await f.job.run();
    assert.equal(f.cached('region-a').product.ec2_vm[0].planList[0].amount, 1);
    assert.equal(await f.redis.cache.unchanged(group('v2')), false);
    await f.job.run();
    assert.equal(f.cached('region-a').product.ec2_vm[0].planList[0].amount, 3);
    assert.equal(await f.redis.cache.unchanged(group('v3')), true);
  });
});
