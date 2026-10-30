import assert from 'node:assert/strict';
import CalculatorController from '../../../app/controller/calculator';
import { CalculatorInputError, CalculatorNotFoundError, CalculatorDataUnavailableError } from '../../../app/module/calculatorReader';

function context(result: unknown, error?: Error) {
  const calls: unknown[] = [];
  const read = async (query: unknown) => { calls.push(query); if (error) { throw error; } return result; };
  const ctx = {
    app: { calculatorReaderRuntime: { service: { configDocument: read, productInfo: read, menuInfo: read, language: read } } },
    query: { urlPath: 'ecs', language: 'zh-cn' }, type: '', status: 0, body: undefined as unknown,
    throw(status: number, message: string): never { throw Object.assign(new Error(message), { status }); },
  };
  return { calls, ctx, controller: new CalculatorController(ctx as never) };
}
describe('calculator read-only controllers', () => {
  it('returns raw config JavaScript with its correct content type', async () => {
    const f = context('const dataConfig = {};');
    await f.controller.getConfig();
    assert.equal(f.ctx.body, 'const dataConfig = {};');
    assert.equal(f.ctx.type, 'application/javascript');
    assert.equal(f.ctx.status, 200);
  });
  it('returns productInfo and menuInfo as JSON objects', async () => {
    for (const method of [ 'productInfo', 'menuInfo', 'language' ] as const) {
      const f = context({ product: {} });
      await f.controller[method]();
      assert.deepEqual(f.ctx.body, { product: {} });
      assert.equal(f.ctx.type, 'application/json');
      assert.equal(f.ctx.status, 200);
      assert.deepEqual(f.calls, [ f.ctx.query ]);
    }
  });
  it('maps invalid/missing/unavailable data to 400/404/503 and does not hide unexpected errors', async () => {
    for (const [ error, status ] of [[ new CalculatorInputError('invalid'), 400 ],
      [ new CalculatorNotFoundError('missing'), 404 ], [ new CalculatorDataUnavailableError('unavailable'), 503 ]] as const) {
      const f = context(null, error);
      await assert.rejects(f.controller.productInfo(), { status });
    }
    const f = context(null, new Error('unexpected'));
    await assert.rejects(f.controller.menuInfo(), /unexpected/);
  });
});
