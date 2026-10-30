import assert from 'node:assert/strict';
import { readerConfiguration } from '../../../../config/reader';

describe('background refresh configuration', () => {
  let original: NodeJS.ProcessEnv;
  beforeEach(() => {
    original = { ...process.env };
    for (const name of Object.keys(process.env)) {
      if (/^(MONGO_|REDIS_|CALCULATOR_)/.test(name)) { delete process.env[name]; }
    }
    process.env.MONGO_URI = 'mongodb://mongo-test.invalid/test';
  });
  afterEach(() => { process.env = original; });

  it('defaults to an enabled check every 60 seconds', () => {
    assert.deepEqual(readerConfiguration().settings.refresh, { enabled: true, intervalMs: 60000 });
    assert.equal(readerConfiguration().connections.redis, undefined);
  });

  it('accepts a custom interval and explicit disabling', () => {
    process.env.CALCULATOR_REFRESH_INTERVAL_MS = '30000';
    process.env.CALCULATOR_REFRESH_ENABLED = 'false';
    assert.deepEqual(readerConfiguration().settings.refresh, { enabled: false, intervalMs: 30000 });
  });

  it('rejects invalid intervals and ambiguous enabled flags', () => {
    for (const value of [ '0', '-1', 'abc', '1.5', '2147483648' ]) {
      process.env.CALCULATOR_REFRESH_INTERVAL_MS = value;
      assert.throws(() => readerConfiguration(), /CALCULATOR_REFRESH_INTERVAL_MS/);
    }
    delete process.env.CALCULATOR_REFRESH_INTERVAL_MS;
    process.env.CALCULATOR_REFRESH_ENABLED = 'maybe';
    assert.throws(() => readerConfiguration(), /CALCULATOR_REFRESH_ENABLED/);
  });
});
