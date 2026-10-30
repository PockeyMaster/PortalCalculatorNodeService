import assert from 'node:assert/strict';
import { CalculatorReadService, CalculatorInputError } from '../../../../app/module/calculatorReader';
import type { CalculatorLookup } from '../../../../app/module/calculatorReader';

describe('language read endpoint', () => {
  it('reads the fixed language key, supports Redis and Mongo fallback, and hides version selection', async () => {
    for (const cached of [ true, false ]) {
      const keys: string[] = [];
      const lookups: CalculatorLookup[] = [];
      const body = JSON.stringify({ ecs: { cpu: 'CPU' } });
      const service = new CalculatorReadService({ async get(key) { keys.push(key); return cached ? body : null; } },
        { async read(lookup) { lookups.push(lookup); return body; } },
        { site: 'zh-HK', channel: 'prod', redisTimeoutMs: 100, mongoTimeoutMs: 100 });
      assert.deepEqual(await service.language({ urlPath: 'all', language: 'en-us', buildId: 'ignored' }), { ecs: { cpu: 'CPU' } });
      assert.deepEqual(keys, [ 'PortalCalculatorNodeService:v4:language:language_en-us' ]);
      assert.equal(lookups.length, cached ? 0 : 1);
      if (!cached) { assert.equal('buildId' in lookups[0], false); }
    }
  });

  it('rejects an invalid language before reading storage', async () => {
    const service = new CalculatorReadService({ async get() { assert.fail('must not query Redis'); } },
      { async read() { assert.fail('must not query Mongo'); } },
      { site: 'zh-CN', channel: 'gray', redisTimeoutMs: 100, mongoTimeoutMs: 100 });
    await assert.rejects(service.language({ language: 'invalid' }), CalculatorInputError);
  });
});
