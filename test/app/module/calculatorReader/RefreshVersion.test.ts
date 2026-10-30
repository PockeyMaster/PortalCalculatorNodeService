import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { MongoCurrentRepository } from '../../../../app/module/calculatorReader/MongoCurrentRepository';
import type { CalculatorLookup, ReaderObject } from '../../../../app/module/calculatorReader/types';

describe('pinned Mongo refresh reads', () => {
  it('refuses a product pointer that changed since discovery, using primary reads', async () => {
    let count = 0;
    const db = { collection() { return { async findOne(_filter: unknown, options: ReaderObject) {
      count++;
      assert.equal(options.readPreference, 'primary');
      return { buildId: 'new-build' };
    } }; } } as unknown as Db;
    const lookup: CalculatorLookup = { type: 'productInfo', site: 'zh-CN', channel: 'gray', service: 'ecs',
      region: 'region-1', tag: 'general.online.portal', tab: 'calc', stableKey: 'key' };
    await assert.rejects(new MongoCurrentRepository(db).readVersion(lookup, 'old-build'), /version changed/);
    assert.equal(count, 1);
  });

  it('pins compiled build and hash while preserving default preference for HTTP reads', async () => {
    const document = { hello: 'world' };
    const body = JSON.stringify(document);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const preferences: unknown[] = [];
    const db = { collection() { return { async findOne(_filter: unknown, options: ReaderObject) {
      preferences.push(options.readPreference);
      return { document, buildId: 'new', sha256, byteLength: Buffer.byteLength(body) };
    } }; } } as unknown as Db;
    const lookup: CalculatorLookup = { type: 'language', site: 'zh-CN', channel: 'gray', stableKey: 'key' };
    const reader = new MongoCurrentRepository(db);
    await assert.rejects(reader.readVersion(lookup, `old:${sha256}`), /version changed/);
    assert.equal(await reader.readVersion(lookup, `new:${sha256}`), body);
    assert.equal(await reader.read(lookup), body);
    assert.deepEqual(preferences, [ 'primary', 'primary', undefined ]);
  });
});
