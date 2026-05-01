import { describe, it, before } from 'node:test';
import assert from 'node:assert';
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

  describe('miss tracking', () => {
    it('should track misses for non-existent keys', async () => {
      await cache.flush();
      await cache.recreate(); // Reset stats by recreating the database
      await cache.get('nonexistent_key');
      await cache.get('another_nonexistent_key');
      const stats = await cache.getStats();
      assert.strictEqual(stats.misses, 2);
      assert.strictEqual(stats.hits, 0);
    });

    it('should count expired entries as misses', async () => {
      await cache.flush();
      await cache.recreate(); // Reset stats by recreating the database
      await cache.set('expired_key', 'test_tool', { query: 'test' }, { result: 'data' }, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
      await cache.get('expired_key');
      const stats = await cache.getStats();
      assert.strictEqual(stats.misses, 1);
      assert.strictEqual(stats.hits, 0);
    });

    it('should calculate hit rate correctly with hits and misses', async () => {
      await cache.flush();
      await cache.recreate(); // Reset stats by recreating the database
      await cache.set('hit_key', 'test_tool', { query: 'test' }, { result: 'data' }, 3600);
      await cache.get('hit_key');
      await cache.get('hit_key');
      await cache.get('miss_key');
      await cache.get('another_miss_key');
      const stats = await cache.getStats();
      assert.strictEqual(stats.hits, 2);
      assert.strictEqual(stats.misses, 2);
      assert.strictEqual(stats.hitRate, 0.5);
    });

    it('should return zero misses when stats row does not exist', async () => {
      await cache.flush();
      // Create a new cache instance to test stats initialization
      const freshCache = new CacheStore({ path: ':memory:', maxSizeBytes: 1000, defaultTtlSeconds: 3600 });
      const stats = await freshCache.getStats();
      assert.strictEqual(stats.misses, 0);
      freshCache.close();
    });
  });

  describe('LRU eviction', () => {
    it('should calculate sizeBytes correctly in stats', async () => {
      const freshCache = new CacheStore({ path: ':memory:', maxSizeBytes: 10000, defaultTtlSeconds: 3600 });
      await freshCache.set('key1', 'tool1', { data: 'test' }, { result: 'value' }, 3600);
      const stats = await freshCache.getStats();
      assert.strictEqual(stats.sizeBytes > 0, true);
      assert.strictEqual(stats.cached, 1);
      freshCache.close();
    });

    it('should evict entries when cache size exceeds maxSizeBytes', async () => {
      const freshCache = new CacheStore({ path: ':memory:', maxSizeBytes: 100, defaultTtlSeconds: 3600 });
      // Add entries that will exceed the max size
      await freshCache.set('key1', 'tool1', { data: 'first' }, { result: 'value1' }, 3600);
      await freshCache.set('key2', 'tool2', { data: 'second' }, { result: 'value2' }, 3600);
      await freshCache.set('key3', 'tool3', { data: 'third' }, { result: 'value3' }, 3600);

      const stats = await freshCache.getStats();
      // Cache should be under max size after eviction
      assert.strictEqual(stats.sizeBytes <= freshCache['config'].maxSizeBytes, true);
      // Some entries should have been evicted
      assert.ok(stats.cached < 3);
      freshCache.close();
    });

    it('should evict least recently used entries first', async () => {
      const freshCache = new CacheStore({ path: ':memory:', maxSizeBytes: 200, defaultTtlSeconds: 3600 });

      // Create entries with significantly different access patterns
      await freshCache.set('key_least_used', 'tool', { data: 'a' }, { result: 'result_a' }, 3600); // Will stay at 0 hits
      await freshCache.set('key_most_used', 'tool', { data: 'b' }, { result: 'result_b' }, 3600);   // Will get many hits
      await freshCache.set('key_medium_used', 'tool', { data: 'c' }, { result: 'result_c' }, 3600); // Will get some hits

      // Create distinct access patterns
      await freshCache.get('key_most_used');    // +1 hit
      await freshCache.get('key_most_used');    // +1 hit
      await freshCache.get('key_medium_used');  // +1 hit
      // key_least_used: 0 hits

      // Add a larger entry to force eviction
      await freshCache.set('key_trigger', 'tool', { data: 'd'.repeat(100) }, { result: 'large_result' }, 3600);

      const stats = await freshCache.getStats();
      assert.ok(stats.sizeBytes <= 200, 'Cache should be under max size');

      // The least recently used entry should be evicted first
      assert.strictEqual(
        await freshCache.get('key_least_used'),
        null,
        'Entry with 0 hits should be evicted before entries with hits'
      );

      freshCache.close();
    });

    it('should not evict when cache is under max size', async () => {
      const freshCache = new CacheStore({ path: ':memory:', maxSizeBytes: 10000, defaultTtlSeconds: 3600 });
      await freshCache.set('key1', 'tool1', { data: 'small' }, { result: 'value' }, 3600);
      await freshCache.set('key2', 'tool2', { data: 'small' }, { result: 'value' }, 3600);

      const stats = await freshCache.getStats();
      // All entries should remain
      assert.strictEqual(stats.cached, 2);
      assert.ok(stats.sizeBytes < 10000);

      freshCache.close();
    });
  });
});
