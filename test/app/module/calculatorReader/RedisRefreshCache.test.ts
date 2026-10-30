import assert from 'node:assert/strict';
import type Redis from 'ioredis';
import { RedisRefreshCache, REFRESH_RENEW, REFRESH_RELEASE, REFRESH_WRITE, REFRESH_COMPLETE } from '../../../../app/module/calculatorReader/RedisRefreshCache';
import type { RefreshGroup } from '../../../../app/module/calculatorReader/CacheRefreshService';
import type { CalculatorLookup } from '../../../../app/module/calculatorReader/types';

const group: RefreshGroup = { id: 'compiled:key', type: 'config', stableKey: 'key', version: 'v1:hash' };
const lookup: CalculatorLookup = { type: 'config', stableKey: 'key', site: 'zh-CN', channel: 'gray' };

// 模拟每个 Lua 脚本的原子行为，不连接任何真实 Redis。
function fixture() {
  const values = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  let connects = 0;
  function hash(key: string) {
    if (!hashes.has(key)) { hashes.set(key, new Map()); }
    return hashes.get(key)!;
  }
  const redis = {
    async set(key: string, value: string, px: string, ttl: number, nx: string) {
      assert.equal(px, 'PX'); assert.equal(ttl, 30000); assert.equal(nx, 'NX');
      if (values.has(key)) { return null; }
      values.set(key, value); return 'OK';
    },
    async hget(key: string, field: string) { return hash(key).get(field) ?? null; },
    async hvals(key: string) { return [ ...hash(key).values() ]; },
    pipeline() {
      const keys: string[] = [];
      return { exists(key: string) { keys.push(key); return this; },
        async exec() { return keys.map(key => [ null, values.has(key) ? 1 : 0 ]); } };
    },
    async eval(script: string, count: number, ...args: Array<string | number>) {
      const keys = args.slice(0, count) as string[];
      const argv = args.slice(count) as string[];
      if (values.get(keys[0]) !== argv[0]) { return 0; }
      if (script === REFRESH_RENEW) { return 1; }
      if (script === REFRESH_RELEASE) { values.delete(keys[0]); return 1; }
      if (script === REFRESH_WRITE) {
        values.set(keys[1], argv[1]); hash(keys[2]).set(keys[1], argv[2]); return 1;
      }
      assert.equal(script, REFRESH_COMPLETE);
      hash(keys[1]).set(argv[1], argv[2]); return 1;
    },
  } as unknown as Redis;
  const cache = new RedisRefreshCache(redis, 'zh-CN', 'gray', async () => { connects++; });
  return { cache, values, hashes, connects: () => connects };
}

describe('Redis refresh ownership and persistent metadata', () => {
  it('acquires once and never renews or releases a different owner lease', async () => {
    const f = fixture();
    assert.equal(await f.cache.acquire('owner', 30000), true);
    assert.equal(await f.cache.acquire('other', 30000), false);
    assert.equal(f.connects(), 2);
    assert.equal(await f.cache.renew('other', 30000), false);
    await f.cache.release('other');
    assert.equal(await f.cache.renew('owner', 30000), true);
    await f.cache.release('owner');
    assert.equal(await f.cache.acquire('other', 30000), true);
  });

  it('fences writes and version markers after a lease expires and another process acquires it', async () => {
    const f = fixture();
    await f.cache.acquire('old', 30000);
    assert.equal(await f.cache.write('old', group, lookup, 'first'), true);
    await f.cache.release('old');
    await f.cache.acquire('new', 30000);
    assert.equal(await f.cache.write('old', group, lookup, 'stale'), false);
    assert.equal(await f.cache.complete('old', group, [ 'key' ]), false);
    assert.equal(f.values.get('key'), 'first');
    assert.equal(await f.cache.unchanged(group), false);
    assert.equal(await f.cache.write('new', group, lookup, 'latest'), true);
    assert.equal(await f.cache.complete('new', group, [ 'key' ]), true);
    assert.equal(f.values.get('key'), 'latest');
    assert.equal(await f.cache.unchanged(group), true);
  });

  it('retains target dimensions even if a round never completes, without splitting underscore keys', async () => {
    const f = fixture();
    const target = { ...lookup, stableKey: 'svc_with_underscore_tag_with_underscore_region_calc' };
    await f.cache.acquire('owner', 30000);
    await f.cache.write('owner', group, target, 'body');
    assert.deepEqual(await f.cache.managed(group), [ target ]);
    assert.equal(await f.cache.unchanged(group), false);
  });

  it('repairs missing keys but skips an unchanged complete generation, including an empty service', async () => {
    const f = fixture();
    await f.cache.acquire('owner', 30000);
    await f.cache.write('owner', group, lookup, 'body');
    await f.cache.complete('owner', group, [ 'key' ]);
    assert.equal(await f.cache.unchanged(group), true);
    f.values.delete('key');
    assert.equal(await f.cache.unchanged(group), false);
    assert.equal(await f.cache.unchanged({ ...group, version: 'v2:hash' }), false);
    const empty: RefreshGroup = { id: 'productInfo:retired', version: 'empty', type: 'productInfo', service: 'retired' };
    await f.cache.complete('owner', empty, []);
    assert.equal(await f.cache.unchanged(empty), true);
  });

  it('treats corrupt version markers as needing refresh and corrupt inventory as an error', async () => {
    const f = fixture();
    await f.cache.acquire('owner', 30000);
    await f.cache.complete('owner', group, [ 'key' ]);
    const versions = [ ...f.hashes.values() ].find(value => value.has(group.id))!;
    for (const invalid of [ 'broken', 'null', '{"version": "v1:hash", "keys": [1]}' ]) {
      versions.set(group.id, invalid);
      assert.equal(await f.cache.unchanged(group), false);
    }
    await f.cache.write('owner', group, lookup, 'body');
    const inventory = [ ...f.hashes.values() ].find(value => value.has('key'))!;
    inventory.set('key', 'broken');
    await assert.rejects(f.cache.managed(group));
  });
});
