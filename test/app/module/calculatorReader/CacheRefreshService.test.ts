import assert from 'node:assert/strict';
import { CacheRefreshService } from '../../../../app/module/calculatorReader/CacheRefreshService';
import type { RefreshCache, RefreshGroup, RefreshSource } from '../../../../app/module/calculatorReader/CacheRefreshService';
import type { CalculatorLookup } from '../../../../app/module/calculatorReader/types';

function fixture() {
  const group: RefreshGroup = { id: 'productInfo:ecs', version: 'v1', type: 'productInfo', service: 'ecs' };
  const target: CalculatorLookup = { site: 'zh-CN', channel: 'gray', type: 'productInfo', service: 'ecs',
    tag: 'online', region: 'region', tab: 'calc', stableKey: 'product-key' };
  const values = new Map<string, string>();
  const versions = new Map<string, { version: string; keys: string[] }>();
  const inventory = new Map<string, CalculatorLookup>();
  const controls = { owner: '', lists: 0, renders: 0, current: true, writes: 0, loseOnWrite: false };
  const logs: unknown[][] = [];
  const logger = { info(...args: unknown[]) { logs.push(args); }, warn(...args: unknown[]) { logs.push(args); }, error(...args: unknown[]) { logs.push(args); } };
  const source: RefreshSource = {
    async list() { controls.lists++; return [ group ]; },
    async targets() { return [ target ]; },
    async read() { controls.renders++; return JSON.stringify({ version: group.version }); },
    async isCurrent() { return controls.current; },
  };
  const cache: RefreshCache = {
    async acquire(token) { if (controls.owner) { return false; } controls.owner = token; return true; },
    async renew(token) { return controls.owner === token; },
    async release(token) { if (controls.owner === token) { controls.owner = ''; } },
    async unchanged(item) {
      const state = versions.get(item.id);
      return state?.version === item.version && state.keys.every(key => values.has(key));
    },
    async managed() { return [ ...inventory.values() ]; },
    async write(token, _group, lookup, body) {
      if (controls.loseOnWrite || controls.owner !== token) { return false; }
      values.set(lookup.stableKey, body); inventory.set(lookup.stableKey, lookup); controls.writes++; return true;
    },
    async complete(token, item, keys) {
      if (controls.owner !== token) { return false; }
      versions.set(item.id, { version: item.version, keys }); return true;
    },
  };
  const service = new CacheRefreshService(source, cache, 60000, logger);
  return { group, target, values, versions, inventory, controls, logs, logger, source, cache, service };
}

describe('background cache refresh coordination', () => {
  it('fills the cache on the first round, skips unchanged versions and repairs missing data keys', async () => {
    const f = fixture();
    await f.service.run();
    assert.equal(f.controls.renders, 1);
    assert.equal(f.versions.get(f.group.id)?.version, 'v1');
    await f.service.run();
    assert.equal(f.controls.renders, 1);
    f.values.delete(f.target.stableKey);
    await f.service.run();
    assert.equal(f.controls.renders, 2);
    f.group.version = 'v2';
    await f.service.run();
    assert.equal(JSON.parse(f.values.get(f.target.stableKey)!).version, 'v2');
    await f.service.stop();
  });

  it('does not read Mongo if another instance owns the lease', async () => {
    const f = fixture();
    f.controls.owner = 'another-instance';
    await f.service.run();
    assert.equal(f.controls.lists, 0);
    assert.equal(f.controls.owner, 'another-instance');
  });

  it('does not overlap local rounds or schedule a first Mongo call during startup', async () => {
    const f = fixture();
    let release!: () => void;
    f.source.list = async () => { f.controls.lists++; await new Promise<void>(resolve => { release = resolve; }); return []; };
    f.service.start();
    assert.equal(f.controls.lists, 0);
    const one = f.service.run();
    assert.equal(f.service.run(), one);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.controls.lists, 1);
    release(); await one; await f.service.stop();
  });

  it('keeps old cache on source failure and retries without exposing the underlying error text', async () => {
    const f = fixture();
    f.values.set(f.target.stableKey, 'previous');
    f.source.read = async () => { throw new Error('SECRET_CREDENTIAL'); };
    await f.service.run();
    assert.equal(f.values.get(f.target.stableKey), 'previous');
    assert.equal(f.versions.size, 0);
    assert.equal(JSON.stringify(f.logs).includes('SECRET_CREDENTIAL'), false);
    assert.equal(f.controls.owner, '');
  });

  it('does not publish or acknowledge a source version that changed while rendering', async () => {
    const f = fixture();
    f.values.set(f.target.stableKey, 'previous');
    f.controls.current = false;
    await f.service.run();
    assert.equal(f.values.get(f.target.stableKey), 'previous');
    assert.equal(f.versions.size, 0);
  });

  it('cannot write after losing the lease and cannot advance its version marker', async () => {
    const f = fixture();
    f.values.set(f.target.stableKey, 'new-owner-data');
    f.controls.loseOnWrite = true;
    await f.service.run();
    assert.equal(f.values.get(f.target.stableKey), 'new-owner-data');
    assert.equal(f.versions.size, 0);
  });

  it('overwrites retired keys with valid empty products, including an entirely empty service', async () => {
    const f = fixture();
    await f.service.run();
    f.group.version = 'empty-version';
    f.source.targets = async () => [];
    f.source.read = async () => JSON.stringify({ product: {}, period: {} });
    await f.service.run();
    assert.deepEqual(JSON.parse(f.values.get(f.target.stableKey)!), { product: {}, period: {} });
    assert.deepEqual(f.versions.get(f.group.id), { version: 'empty-version', keys: [] });
  });

  it('retains per-key inventory after an interrupted round so transient new keys can be cleared', async () => {
    const f = fixture();
    let checks = 0;
    const transient = { ...f.target, stableKey: 'transient-key' };
    f.source.targets = async () => [ transient, f.target ];
    f.source.isCurrent = async () => ++checks === 1;
    await f.service.run();
    assert.equal(f.inventory.has('transient-key'), true);
    assert.equal(f.versions.size, 0);
    f.group.version = 'new-version';
    f.source.targets = async () => [];
    f.source.isCurrent = async () => true;
    f.source.read = async () => 'empty';
    await f.service.run();
    assert.equal(f.values.get('transient-key'), 'empty');
  });

  it('honors a configured interval and stops scheduling after shutdown', async () => {
    const f = fixture();
    const service = new CacheRefreshService(f.source, f.cache, 10, f.logger);
    service.start();
    const deadline = Date.now() + 1000;
    while (f.controls.lists < 2 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(f.controls.lists >= 2);
    await service.stop();
    const count = f.controls.lists;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.controls.lists, count);
  });
});
