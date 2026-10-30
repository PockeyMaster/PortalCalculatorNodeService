import assert from 'node:assert/strict';
import { CalculatorReadService, CalculatorKey, CalculatorDataUnavailableError, CalculatorInputError, CalculatorNotFoundError } from '../../../../app/module/calculatorReader';
import type { CalculatorLookup, CalculatorReaderConfig } from '../../../../app/module/calculatorReader';

const settings: CalculatorReaderConfig = { site: 'zh-CN', channel: 'gray', redisTimeoutMs: 20, mongoTimeoutMs: 5000 };
const query = { urlPath: 'ecs', tag: 'general.online.portal', region: 'cn-north-4', tab: 'calc' };
const document = { urlPath: 'ecs', tag: query.tag, region: query.region, tab: query.tab, product: {}, period: {} };
function fixture(cached: string | null = null, stored: string | null = JSON.stringify(document)) {
  const keys: string[] = [];
  const lookups: CalculatorLookup[] = [];
  const redis = { async get(key: string) { keys.push(key); return cached; } };
  const mongo = { async read(lookup: CalculatorLookup) { lookups.push(lookup); return stored; } };
  return { keys, lookups, redis, mongo, reader: new CalculatorReadService(redis, mongo, settings) };
}
describe('portable calculator reader', () => {
  it('returns Redis without querying Mongo and treats an empty product as a valid hit', async () => {
    const { reader, lookups, keys } = fixture(JSON.stringify(document));
    assert.deepEqual(await reader.productInfo(query), document);
    assert.equal(lookups.length, 0);
    assert.deepEqual(keys, [ 'PortalCalculatorNodeService:gray:productInfo:ecs_general.online.portal_cn-north-4_calc' ]);
  });
  it('falls back on cache miss, Redis errors, timeout, malformed JSON and mismatched dimensions', async () => {
    for (const mode of [ 'missing', 'error', 'timeout', 'malformed', 'wrong-region' ]) {
      const { reader, redis, lookups } = fixture();
      if (mode === 'error') { redis.get = async () => { throw new Error('Redis unavailable'); }; }
      if (mode === 'timeout') { redis.get = async () => new Promise(() => { /* never resolves */ }); }
      if (mode === 'malformed') { redis.get = async () => 'invalid JSON'; }
      if (mode === 'wrong-region') { redis.get = async () => JSON.stringify({ ...document, region: 'other-region' }); }
      assert.deepEqual(await reader.productInfo(query), document, mode);
      assert.equal(lookups.length, 1, mode);
    }
  });
  it('does not read/validate sign, language, site or channel from productInfo queries', async () => {
    const { reader, lookups } = fixture();
    await reader.productInfo({ ...query, sign: 'anything', language: 'anything', site: 'zh-HK', channel: 'prod' });
    assert.equal(lookups[0]!.site, 'zh-CN');
    assert.equal(lookups[0]!.channel, 'gray');
    assert.equal(lookups[0]!.stableKey, CalculatorKey.productInfo({ channel: 'gray', service: 'ecs', tag: query.tag, region: query.region, tab: 'calc' }));
  });
  it('supports config language and typo alias without executing or JSON-wrapping the JavaScript', async () => {
    const text = 'const dataConfig = { text: "hello" };';
    const { reader, keys } = fixture(text);
    assert.equal(await reader.configDocument({ urlPaht: 'ecs', language: 'en-us' }), text);
    assert.equal(keys[0], 'PortalCalculatorNodeService:gray:config:ecs_en-us');
    const fallback = fixture(null, text);
    assert.equal(await fallback.reader.configDocument({ urlPath: 'ecs' }), text);
    assert.equal(fallback.lookups[0]!.stableKey, 'PortalCalculatorNodeService:gray:config:ecs_zh-cn');
  });
  it('uses sign/language for menu and accepts common/cpq', async () => {
    const { reader, keys } = fixture(JSON.stringify({ menuInfos: [] }));
    assert.deepEqual(await reader.menuInfo({ sign: 'cpq', language: 'es-us' }), { menuInfos: [] });
    assert.equal(keys[0], 'PortalCalculatorNodeService:gray:menuInfo:cpq_es-us');
  });
  it('separates international/prod via deployment settings rather than Key site suffix', async () => {
    const f = fixture();
    const reader = new CalculatorReadService(f.redis, f.mongo, { ...settings, site: 'zh-HK', channel: 'prod' });
    await reader.productInfo(query);
    assert.equal(f.lookups[0]!.site, 'zh-HK');
    assert.equal(f.keys[0], 'PortalCalculatorNodeService:v4:productInfo:ecs_general.online.portal_cn-north-4_calc');
  });
  it('preserves listCalc arrays including empty results', async () => {
    const value = { ...document, tab: 'listCalc', product: [] };
    const f = fixture(JSON.stringify(value));
    assert.deepEqual(await f.reader.productInfo({ ...query, tab: 'listCalc' }), value);
    assert.equal(f.lookups.length, 0);
  });
  it('distinguishes missing data from database failure/corruption', async () => {
    const missing = fixture(null, null);
    await assert.rejects(missing.reader.productInfo(query), CalculatorNotFoundError);
    const broken = fixture();
    broken.mongo.read = async () => { throw new Error('database error'); };
    await assert.rejects(broken.reader.productInfo(query), CalculatorDataUnavailableError);
    const invalid = fixture(null, '[]');
    await assert.rejects(invalid.reader.productInfo(query), CalculatorDataUnavailableError);
  });
  it('rejects missing region/tag/tab and invalid config/menu input before any read', async () => {
    const f = fixture();
    for (const key of [ 'region', 'tag', 'tab', 'urlPath' ]) {
      const invalid: Record<string, unknown> = { ...query };
      delete invalid[key];
      await assert.rejects(f.reader.productInfo(invalid), CalculatorInputError);
    }
    await assert.rejects(f.reader.productInfo({ ...query, tab: 'unknown' }), CalculatorInputError);
    await assert.rejects(f.reader.configDocument({ urlPath: 'ecs', urlPaht: 'mrs' }), CalculatorInputError);
    await assert.rejects(f.reader.configDocument({ urlPath: 'ecs', language: 'zh-CN' }), CalculatorInputError);
    await assert.rejects(f.reader.menuInfo({ sign: 'sp' }), CalculatorInputError);
    await assert.rejects(f.reader.configDocument({ urlPath: [ 'ecs' ] }), CalculatorInputError);
    await assert.rejects(f.reader.productInfo({ ...query, region: 'region\u0000' }), CalculatorInputError);
    assert.equal(f.keys.length, 0);
    assert.equal(f.lookups.length, 0);
  });
});
