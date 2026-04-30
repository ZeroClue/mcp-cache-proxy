import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { unlinkSync, existsSync } from 'node:fs';
import { CacheStore } from '../src/cache.ts';

const TEST_DB = ':memory:';

describe('CacheStore', () => {
  let cache: CacheStore;

  before(() => {
    cache = new CacheStore({ path: TEST_DB, maxSizeBytes: 1000, defaultTtlSeconds: 3600 });
  });

  it('should store and retrieve cached result', async () => {
    await cache.set('key1', 'test_tool', { query: 'test' }, { result: 'data' }, 3600);
    const result = await cache.get('key1');
    assert.deepStrictEqual(result, { result: 'data' });
  });

  it('should return null for non-existent key', async () => {
    const result = await cache.get('nonexistent');
    assert.strictEqual(result, null);
  });

  it('should respect TTL expiration', async () => {
    await cache.set('key2', 'test_tool', { query: 'test' }, { result: 'data' }, 0); // Expired
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = await cache.get('key2');
    assert.strictEqual(result, null);
  });

  it('should increment hit counter', async () => {
    await cache.flush();
    await cache.set('key3', 'test_tool', { query: 'test' }, { result: 'data' }, 3600);
    await cache.get('key3');
    await cache.get('key3');
    const stats = await cache.getStats();
    assert.strictEqual(stats.hits, 2);
  });

  it('should flush all entries', async () => {
    await cache.set('key4', 'test_tool', { query: 'test' }, { result: 'data' }, 3600);
    await cache.flush();
    const result = await cache.get('key4');
    assert.strictEqual(result, null);
  });

  it('should flush per-tool entries', async () => {
    await cache.set('key5', 'tool_a', { query: 'test' }, { result: 'a' }, 3600);
    await cache.set('key6', 'tool_b', { query: 'test' }, { result: 'b' }, 3600);
    await cache.flush('tool_a');
    assert.strictEqual(await cache.get('key5'), null);
    assert.deepStrictEqual(await cache.get('key6'), { result: 'b' });
  });

  it('should return accurate stats', async () => {
    await cache.flush();
    await cache.set('key7', 'test_tool', { query: 'test' }, { result: 'data' }, 3600);
    await cache.get('key7');
    const stats = await cache.getStats();
    assert.strictEqual(stats.cached, 1);
    assert.strictEqual(stats.hits, 1);
  });
});
