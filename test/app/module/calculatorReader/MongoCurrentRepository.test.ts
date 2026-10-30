import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { MongoCurrentRepository } from '../../../../app/module/calculatorReader/MongoCurrentRepository';
import { CalculatorKey } from '../../../../app/module/calculatorReader/CalculatorKey';
import type { CalculatorLookup, ReaderObject } from '../../../../app/module/calculatorReader/types';

const query: CalculatorLookup = { type: 'productInfo', site: 'zh-CN', channel: 'gray',
  service: 'ecs', tag: 'general.online.portal', region: 'test-region', tab: 'calc',
  stableKey: CalculatorKey.productInfo({ channel: 'gray', service: 'ecs', tag: 'general.online.portal', region: 'test-region', tab: 'calc' }) };

function fixture() {
  const state = {
    current: { site: 'zh-CN', channel: 'gray', service: 'ecs', buildId: 'current-version', skuCount: 1 } as ReaderObject | null,
    build: { status: 'ready', skuCount: 1, request: { channel: 'gray', config: { service: 'ecs' } }, keys: [ query.stableKey ] } as ReaderObject,
    rows: [{ channel: 'gray', service: 'ecs', buildId: 'current-version', productTag: query.tag, region: query.region, tabs: [ 'calc' ],
      bucket: 'ec2_vm', resourceType: 'hws.resource.type.vm', cloudServiceType: 'hws.service.type.ec2', resourceSpecCode: 'spec',
      planList: [{ amount: 1, billingMode: 'ONDEMAND', billingEvent: 'event', measureUnit: 1 }],
      periodList: [{ periodType: 'MONTH', value: 1 }], attributes: { cpu: '2' }, skuInfo: [ 'CPU:2' ] }] as ReaderObject[],
    compiled: null as ReaderObject | null, queries: [] as Array<{ name: string; filter: ReaderObject }>, closed: 0,
  };
  const db = { collection(name: string) {
    return {
      async findOne(filter: ReaderObject, options: ReaderObject) {
        assert.equal(options.maxTimeMS, 1000);
        state.queries.push({ name, filter });
        if (name.endsWith('_compiled_current_documents')) { return state.compiled; }
        if (name.endsWith('_aggregate_current_states')) { return state.current; }
        if (name.endsWith('_aggregate_builds')) { return state.build; }
        throw new Error(`Unexpected collection ${name}`);
      },
      find(filter: ReaderObject, options: ReaderObject) {
        assert.equal(options.maxTimeMS, 1000);
        state.queries.push({ name, filter });
        return { sort() { return this; }, batchSize() { return this; },
          async close() { state.closed++; }, async* [Symbol.asyncIterator]() { yield* state.rows; } };
      },
    };
  } } as unknown as Db;
  function compiled(type: string, value: unknown) {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    state.compiled = { type, document: value, sha256: createHash('sha256').update(body).digest('hex'), byteLength: Buffer.byteLength(body) };
  }
  return { state, reader: new MongoCurrentRepository(db, 1000), compiled };
}

describe('current Mongo fallback repository', () => {
  it('reads config/menu/language by fixed key from the current view, without publish records or caller buildId', async () => {
    for (const type of [ 'config', 'menuInfo', 'language' ] as const) {
      const f = fixture();
      const value = type === 'config' ? 'var lang = { cpu: "核数" };' : { value: '中文' };
      f.compiled(type, value);
      const key = `PortalCalculatorNodeService:v4:${type}:example`;
      const result = await f.reader.read({ type, site: 'zh-HK', channel: 'prod', stableKey: key });
      assert.equal(result, typeof value === 'string' ? value : JSON.stringify(value));
      assert.deepEqual(f.state.queries, [{ name: 'calculator_intl_compiled_current_documents',
        filter: { stableKey: key, type, channel: 'prod', site: 'zh-HK' } }]);
    }
  });

  it('returns missing current data as null, without selecting a historical version', async () => {
    const f = fixture();
    assert.equal(await f.reader.read({ type: 'menuInfo', site: 'zh-CN', channel: 'gray', stableKey: 'key' }), null);
    f.state.current = null;
    assert.equal(await f.reader.read(query), null);
  });

  it('verifies the compiled body checksum and byte count', async () => {
    for (const field of [ 'sha256', 'byteLength' ]) {
      const f = fixture();
      f.compiled('config', 'var lang = {};');
      f.state.compiled![field] = 'corrupt';
      await assert.rejects(f.reader.read({ type: 'config', site: 'zh-CN', channel: 'gray', stableKey: 'key' }), /checksum/);
    }
  });

  it('reconstructs products from the committed SKU version even though the snapshot is only ready', async () => {
    const f = fixture();
    const result = JSON.parse((await f.reader.read(query))!);
    assert.equal(result.product.ec2_vm[0].cpu, '2');
    assert.equal(result.product.ec2_vm[0].periodList, 0);
    assert.deepEqual(result.period.ec2_vm, [[{ periodType: 'MONTH', value: 1 }]]);
    assert.deepEqual(result.product.ec2_vm[0]._skuInfo, [ 'CPU:2' ]);
    assert.equal(f.state.queries[2]!.name, 'calculator_cn_aggregated_skus');
    assert.deepEqual(f.state.queries[2]!.filter, { channel: 'gray', service: 'ecs', buildId: 'current-version',
      productTag: query.tag, region: query.region, tabs: 'calc' });
    assert.equal(f.state.closed, 1);
  });

  it('does not resurrect regions absent from the current key set or an empty generation', async () => {
    for (const empty of [ false, true ]) {
      const f = fixture();
      if (empty) { f.state.current!.skuCount = 0; f.state.build.skuCount = 0; }
      else { f.state.build.keys = []; }
      const result = JSON.parse((await f.reader.read(query))!);
      assert.deepEqual(result.product, {});
      assert.equal(f.state.queries.length, 2);
    }
  });

  it('rejects missing target rows, failed builds and invalid pointers instead of falling back to old builds', async () => {
    const missing = fixture();
    missing.state.rows = [];
    await assert.rejects(missing.reader.read(query), /rows are missing/);
    const failed = fixture();
    failed.state.build.status = 'failed';
    await assert.rejects(failed.reader.read(query), /incomplete/);
    const wrong = fixture();
    wrong.state.current!.site = 'zh-HK';
    await assert.rejects(wrong.reader.read(query), /pointer/);
  });

  it('preserves free images and location data without re-running service processors', async () => {
    const f = fixture();
    f.state.rows[0]!.locationType = '2';
    f.state.rows[0]!.locationCode = 'test-ies';
    f.state.rows.push({ bucket: 'ec2_vm.image.special', syntheticImage: true, attributes: { id: 'image', name: 'Free image' } });
    const result = JSON.parse((await f.reader.read(query))!);
    assert.equal(result.product.ec2_vm[0].location_code, 'test-ies');
    assert.deepEqual(result.product['ec2_vm.image.special'], [{ id: 'image', name: 'Free image' }]);
  });

  it('supports CPQ listCalc including retired empty results', async () => {
    const f = fixture();
    const lookup = { ...query, tab: 'listCalc' as const, stableKey: query.stableKey.replace(/_calc$/, '_listCalc') };
    f.state.build.keys = [ lookup.stableKey ];
    const result = JSON.parse((await f.reader.read(lookup))!);
    assert.equal(result.product[0].billingTime, 'ONDEMAND_1');
    f.state.build.keys = [];
    const empty = JSON.parse((await f.reader.read(lookup))!);
    assert.deepEqual(empty.product, []);
  });

  it('closes the cursor even when a bad bucket is rejected', async () => {
    const f = fixture();
    f.state.rows[0]!.bucket = '__proto__';
    await assert.rejects(f.reader.read(query), /bucket/);
    assert.equal(f.state.closed, 1);
  });
});
