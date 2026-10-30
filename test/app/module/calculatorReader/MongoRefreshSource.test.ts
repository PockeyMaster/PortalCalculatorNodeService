import assert from 'node:assert/strict';
import type { Db } from 'mongodb';
import { CalculatorKey } from '../../../../app/module/calculatorReader/CalculatorKey';
import { MongoRefreshSource } from '../../../../app/module/calculatorReader/MongoRefreshSource';
import type { RefreshGroup } from '../../../../app/module/calculatorReader/CacheRefreshService';
import type { CalculatorLookup, ReaderObject } from '../../../../app/module/calculatorReader/types';

const dimensions = { tag: 'tag_with_underscore', region: 'region-1', tab: 'calc' as const };
const service = 'svc_with_underscore';
const stableKey = CalculatorKey.productInfo({ channel: 'gray', service, ...dimensions });
const group: RefreshGroup = { id: `productInfo:${service}`, type: 'productInfo', service, version: 'build1' };

function fixture() {
  const state = {
    products: [{ service, buildId: 'build1', skuCount: 1 }],
    compiled: [{ stableKey: 'PortalCalculatorNodeService:gray:language:language_zh-cn', type: 'language', buildId: 'lang1', sha256: 'hash' }],
    currentBuild: 'build1', connects: 0,
    build: { status: 'ready', request: { channel: 'gray', config: { service } }, keys: [ stableKey ], emptyImageTargets: [] as string[] },
    dimensions: [{ _id: dimensions }] as Array<{ _id: typeof dimensions }>,
    queries: [] as Array<{ name: string; filter: ReaderObject; options: ReaderObject }>,
  };
  const db = { collection(name: string) {
    return {
      find(filter: ReaderObject, options: ReaderObject) {
        state.queries.push({ name, filter, options });
        return { async toArray() { return name.endsWith('current_states') ? state.products : state.compiled; } };
      },
      async findOne(filter: ReaderObject, options: ReaderObject) {
        state.queries.push({ name, filter, options });
        if (name.endsWith('_aggregate_builds')) { return state.build; }
        if (name.endsWith('_aggregate_current_states')) { return { buildId: state.currentBuild }; }
        return state.compiled[0];
      },
      aggregate(pipeline: ReaderObject[], options: ReaderObject) {
        state.queries.push({ name, filter: pipeline[0], options });
        return { async toArray() { return state.dimensions; } };
      },
    };
  } } as unknown as Db;
  return { state, source: new MongoRefreshSource(db, { site: 'zh-CN', channel: 'gray', mongoTimeoutMs: 1000, redisTimeoutMs: 100 },
    async () => { state.connects++; }) };
}

describe('Mongo refresh source discovery', () => {
  it('lists only current metadata scoped to deployment channel, prioritizing products before menus/language', async () => {
    const f = fixture();
    const result = await f.source.list();
    assert.equal(f.state.connects, 1);
    assert.equal(result[0].type, 'productInfo');
    assert.equal(result[1].type, 'language');
    for (const query of f.state.queries) {
      assert.ok(query.name.startsWith('calculator_cn_'));
      assert.deepEqual(query.filter, { channel: 'gray' });
      assert.equal(query.options.readPreference, 'primary');
      assert.equal((query.options.projection as ReaderObject).document, undefined);
    }
  });

  it('derives exact targets from stored dimensions without splitting underscore keys', async () => {
    const f = fixture();
    const result = await f.source.targets(group);
    assert.deepEqual(result, [{ type: 'productInfo', site: 'zh-CN', channel: 'gray', service, ...dimensions, stableKey }]);
    assert.deepEqual(f.state.queries[1].filter.$match, { channel: 'gray', service, buildId: 'build1' });
    assert.equal(f.state.queries[1].options.readPreference, 'primary');
  });

  it('supports free-image-only targets and a fully empty service generation', async () => {
    const f = fixture();
    f.state.dimensions = [];
    f.state.build.emptyImageTargets = [ `${dimensions.tag}\u0000${dimensions.region}\u0000calc` ];
    assert.equal((await f.source.targets(group))[0].stableKey, stableKey);
    f.state.build.emptyImageTargets = [];
    f.state.build.keys = [];
    assert.deepEqual(await f.source.targets(group), []);
  });

  it('rejects mismatched target sets, failed builds, malformed dimensions and foreign channels', async () => {
    const mismatch = fixture(); mismatch.state.build.keys = [ 'wrong-key' ];
    await assert.rejects(mismatch.source.targets(group), /targets/);
    const failed = fixture(); failed.state.build.status = 'failed';
    await assert.rejects(failed.source.targets(group), /metadata/);
    const invalid = fixture(); invalid.state.build.emptyImageTargets = [ 'bad' ];
    await assert.rejects(invalid.source.targets(group), /empty image/);
    const foreign = fixture(); foreign.state.build.request.channel = 'prod';
    await assert.rejects(foreign.source.targets(group), /metadata/);
  });

  it('checks the authoritative pointer before acknowledging a generation', async () => {
    const f = fixture();
    assert.equal(await f.source.isCurrent(group), true);
    f.state.currentBuild = 'build2';
    assert.equal(await f.source.isCurrent(group), false);
    const compiled = (await f.source.list())[1];
    assert.equal(await f.source.isCurrent(compiled), true);
    f.state.compiled[0].buildId = 'lang2';
    assert.equal(await f.source.isCurrent(compiled), false);
  });

  it('rejects foreign or altered inventory before reading any document', async () => {
    const f = fixture();
    const lookup: CalculatorLookup = { type: 'productInfo', site: 'zh-CN', channel: 'gray', service, ...dimensions, stableKey };
    for (const altered of [ { site: 'zh-HK' }, { service: 'other' }, { stableKey: 'wrong-key' } ]) {
      await assert.rejects(f.source.read(group, { ...lookup, ...altered } as CalculatorLookup));
    }
    assert.equal(f.state.queries.length, 0);
    f.state.compiled[0].stableKey = 'PortalCalculatorNodeService:v4:language:language_zh-cn';
    await assert.rejects(f.source.list(), /compiled refresh key/);
  });
});
