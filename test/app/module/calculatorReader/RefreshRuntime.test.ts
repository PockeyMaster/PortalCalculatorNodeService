import assert from 'node:assert/strict';
import { CalculatorReaderRuntime } from '../../../../app/module/calculatorReader/CalculatorReaderRuntime';
import type { CalculatorReaderConfig } from '../../../../app/module/calculatorReader/types';

describe('refresh runtime lifecycle', () => {
  const settings: CalculatorReaderConfig = { site: 'zh-CN', channel: 'gray', mongoTimeoutMs: 100, redisTimeoutMs: 100 };
  const connections = { mongoUri: 'mongodb://mongo-test.invalid/test', mongoDb: 'test' };

  it('leaves Mongo fallback usable and skips the task without Redis configuration', async () => {
    const messages: unknown[][] = [];
    const logger = { info: (...args: unknown[]) => { messages.push(args); }, warn() {}, error() {} };
    const runtime = new CalculatorReaderRuntime(settings, connections, logger);
    runtime.startRefresh();
    assert.ok(runtime.service);
    assert.ok(messages.some(args => String(args[0]).includes('disabled')));
    assert.equal(messages[0][2], false);
    await runtime.close();
  });

  it('starts a delayed timer without network I/O and cancels it on close', async () => {
    const messages: unknown[][] = [];
    const logger = { info: (...args: unknown[]) => { messages.push(args); }, warn() {}, error() {} };
    const runtime = new CalculatorReaderRuntime(settings, { ...connections, redis: { host: 'redis-test.invalid', port: 6379 } }, logger);
    assert.equal(messages.length, 0);
    runtime.startRefresh();
    assert.equal(messages.length, 1);
    assert.equal(messages[0][1], 60000);
    await runtime.close();
  });

  it('supports explicit disabling even when Redis exists', async () => {
    const messages: unknown[][] = [];
    const logger = { info: (...args: unknown[]) => { messages.push(args); }, warn() {}, error() {} };
    const runtime = new CalculatorReaderRuntime({ ...settings, refresh: { enabled: false, intervalMs: 30000 } },
      { ...connections, redis: { host: 'redis-test.invalid', port: 6379 } }, logger);
    runtime.startRefresh();
    assert.equal(messages[0][1], false);
    assert.equal(messages[0][2], true);
    await runtime.close();
  });
});
