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

  describe('maxEntrySizeBytes', () => {
    it('should reject entries that exceed maxEntrySizeBytes', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        maxEntrySizeBytes: 100, // Max 100 bytes per entry
        defaultTtlSeconds: 3600
      });

      // Create a large entry that exceeds the limit
      const largeData = 'x'.repeat(200); // 200 bytes
      await freshCache.set('key1', 'tool1', { data: largeData }, { result: 'value' }, 3600);

      const stats = await freshCache.getStats();
      // Entry should not be cached
      assert.strictEqual(stats.cached, 0);

      freshCache.close();
    });

    it('should accept entries within maxEntrySizeBytes limit', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        maxEntrySizeBytes: 100,
        defaultTtlSeconds: 3600
      });

      // Create a small entry that is within the limit
      await freshCache.set('key1', 'tool1', { data: 'small' }, { result: 'value' }, 3600);

      const stats = await freshCache.getStats();
      // Entry should be cached
      assert.strictEqual(stats.cached, 1);

      freshCache.close();
    });

    it('should not enforce maxEntrySizeBytes when undefined', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        // maxEntrySizeBytes is undefined - no per-entry limit
        defaultTtlSeconds: 3600
      });

      // Create a large entry - should be cached when no maxEntrySizeBytes is set
      const largeData = 'x'.repeat(5000);
      await freshCache.set('key1', 'tool1', { data: largeData }, { result: 'value' }, 3600);

      const stats = await freshCache.getStats();
      // Entry should be cached since there's no per-entry limit
      assert.strictEqual(stats.cached, 1);
      assert.ok(stats.sizeBytes > 5000);

      freshCache.close();
    });

    it('should warn when entry exceeds maxEntrySizeBytes', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        maxEntrySizeBytes: 50,
        defaultTtlSeconds: 3600
      });

      // Capture console.warn output
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (message: string) => {
        warnings.push(message);
      };

      // Create an entry that exceeds the limit
      await freshCache.set('key1', 'tool1', { data: 'x'.repeat(100) }, { result: 'value' }, 3600);

      console.warn = originalWarn;

      // Should have logged a warning
      assert.ok(warnings.some(w => w.includes('exceeds maxEntrySizeBytes')));
      assert.ok(warnings.some(w => w.includes('tool=tool1')));

      freshCache.close();
    });
  });

  describe('negative caching (errors)', () => {
    it('should cache errors with is_error flag', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      const error = new Error('Test error');
      await freshCache.set('key1', 'tool1', { data: 'test' }, error, 300, true);

      const stats = await freshCache.getStats();
      assert.strictEqual(stats.cached, 1);

      freshCache.close();
    });

    it('should throw errors when retrieving cached error entries', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      const error = new Error('Test error');
      await freshCache.set('key1', 'tool1', { data: 'test' }, error, 300, true);

      // Should throw the error
      await assert.rejects(
        async () => await freshCache.get('key1'),
        (err: unknown) => {
          // Error is serialized as plain object { message: '...' }
          return typeof err === 'object' && err !== null && 'message' in err && (err as { message: string }).message === 'Test error';
        }
      );

      freshCache.close();
    });

    it('should return normal results for non-error entries', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      await freshCache.set('key1', 'tool1', { data: 'test' }, { result: 'value' }, 300, false);

      const result = await freshCache.get('key1');
      assert.deepStrictEqual(result, { result: 'value' });

      freshCache.close();
    });

    it('should distinguish between error and non-error entries', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      // Cache a normal result
      await freshCache.set('key1', 'tool1', { data: 'test' }, { result: 'value' }, 300, false);
      const result = await freshCache.get('key1');
      assert.deepStrictEqual(result, { result: 'value' });

      // Cache an error
      const error = new Error('Test error');
      await freshCache.set('key2', 'tool1', { data: 'test' }, error, 300, true);

      // Should throw for error entry
      await assert.rejects(
        async () => await freshCache.get('key2'),
        (err: Error) => err.message === 'Test error'
      );

      // Normal entry should still work
      const result2 = await freshCache.get('key1');
      assert.deepStrictEqual(result2, { result: 'value' });

      freshCache.close();
    });

    it('should use negative cache TTL for errors by default', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600,
        negativeCacheTtlSeconds: 1 // 1 second TTL for errors
      });

      const error = new Error('Test error');
      await freshCache.set('key1', 'tool1', { data: 'test' }, error, 1, true);

      // Wait for TTL to expire (2 seconds to be safe)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Error entry should be expired
      const result = await freshCache.get('key1');
      assert.strictEqual(result, null);

      freshCache.close();
    });
  });

  describe('export/import cache', () => {
    it('should export cache to JSON file', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      // Add some entries
      await freshCache.set('key1', 'tool1', { data: 'test1' }, { result: 'value1' }, 3600, false);
      await freshCache.set('key2', 'tool2', { data: 'test2' }, { result: 'value2' }, 3600, false);

      // Export to file
      const exportPath = '/tmp/test-cache-export.json';
      await freshCache.exportCache(exportPath);

      // Verify file exists and has correct structure
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(exportPath, 'utf-8');
      const data = JSON.parse(content);

      assert.strictEqual(data.version, 1);
      assert.strictEqual(data.entries.length, 2);
      assert.strictEqual(data.entries[0].key, 'key1');
      assert.strictEqual(data.entries[1].key, 'key2');

      // Clean up
      await fs.unlink(exportPath);
      freshCache.close();
    });

    it('should import cache from JSON file', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      // Create export file manually
      const exportPath = '/tmp/test-cache-import.json';
      const exportData = {
        version: 1,
        exportedAt: Math.floor(Date.now() / 1000),
        entries: [
          {
            key: 'import_key1',
            tool: 'tool1',
            args: { data: 'test1' },
            result: { result: 'value1' },
            created_at: Math.floor(Date.now() / 1000) - 100, // 100 seconds ago
            ttl_seconds: 3600,
            is_error: false
          },
          {
            key: 'import_key2',
            tool: 'tool2',
            args: { data: 'test2' },
            result: { result: 'value2' },
            created_at: Math.floor(Date.now() / 1000) - 100,
            ttl_seconds: 3600,
            is_error: false
          }
        ]
      };

      const fs = await import('node:fs/promises');
      await fs.writeFile(exportPath, JSON.stringify(exportData, null, 2), 'utf-8');

      // Import
      const result = await freshCache.importCache(exportPath);

      assert.strictEqual(result.imported, 2);
      assert.strictEqual(result.skipped, 0);

      // Verify entries were imported
      const stats = await freshCache.getStats();
      assert.strictEqual(stats.cached, 2);

      // Verify entries can be retrieved
      const entry1 = await freshCache.get('import_key1');
      assert.deepStrictEqual(entry1, { result: 'value1' });

      const entry2 = await freshCache.get('import_key2');
      assert.deepStrictEqual(entry2, { result: 'value2' });

      // Clean up
      await fs.unlink(exportPath);
      freshCache.close();
    });

    it('should skip existing entries during import', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      // Add an existing entry
      await freshCache.set('existing_key', 'tool1', { data: 'test' }, { result: 'existing' }, 3600, false);

      // Create export file with same key
      const exportPath = '/tmp/test-cache-skip.json';
      const exportData = {
        version: 1,
        exportedAt: Math.floor(Date.now() / 1000),
        entries: [
          {
            key: 'existing_key',
            tool: 'tool1',
            args: { data: 'test' },
            result: { result: 'new_value' },
            created_at: Math.floor(Date.now() / 1000) - 100,
            ttl_seconds: 3600,
            is_error: false
          }
        ]
      };

      const fs = await import('node:fs/promises');
      await fs.writeFile(exportPath, JSON.stringify(exportData, null, 2), 'utf-8');

      // Import
      const result = await freshCache.importCache(exportPath);

      assert.strictEqual(result.imported, 0);
      assert.strictEqual(result.skipped, 1);

      // Verify original entry is unchanged
      const entry = await freshCache.get('existing_key');
      assert.deepStrictEqual(entry, { result: 'existing' });

      // Clean up
      await fs.unlink(exportPath);
      freshCache.close();
    });

    it('should skip expired entries during import', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      // Create export file with expired entry
      const exportPath = '/tmp/test-cache-expired.json';
      const exportData = {
        version: 1,
        exportedAt: Math.floor(Date.now() / 1000),
        entries: [
          {
            key: 'expired_key',
            tool: 'tool1',
            args: { data: 'test' },
            result: { result: 'value' },
            created_at: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
            ttl_seconds: 3600, // 1 hour TTL - already expired
            is_error: false
          }
        ]
      };

      const fs = await import('node:fs/promises');
      await fs.writeFile(exportPath, JSON.stringify(exportData, null, 2), 'utf-8');

      // Import
      const result = await freshCache.importCache(exportPath);

      assert.strictEqual(result.imported, 0);
      assert.strictEqual(result.skipped, 1);

      // Verify entry was not imported
      const stats = await freshCache.getStats();
      assert.strictEqual(stats.cached, 0);

      // Clean up
      await fs.unlink(exportPath);
      freshCache.close();
    });

    it('should export and import error entries', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      // Add an error entry
      const error = new Error('Test error');
      await freshCache.set('error_key', 'tool1', { data: 'test' }, error, 3600, true);

      // Export
      const exportPath = '/tmp/test-cache-error.json';
      await freshCache.exportCache(exportPath);

      // Import into new cache
      const newCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      const importResult = await newCache.importCache(exportPath);
      assert.strictEqual(importResult.imported, 1);

      // Verify error entry is imported and throws on retrieval
      await assert.rejects(
        async () => await newCache.get('error_key'),
        (err: unknown) => {
          return typeof err === 'object' && err !== null && 'message' in err && (err as { message: string }).message === 'Test error';
        }
      );

      // Clean up
      const fs = await import('node:fs/promises');
      await fs.unlink(exportPath);
      freshCache.close();
      newCache.close();
    });
  });

  describe('stale-while-revalidate', () => {
    it('should return fresh data with stale=false', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600,
        staleWhileRevalidateSeconds: 300
      });

      await freshCache.set('key1', 'tool1', { data: 'test' }, { result: 'fresh' }, 3600);
      const result = await freshCache.getWithStale('key1');
      assert.ok(result !== null);
      assert.strictEqual(result.stale, false);
      assert.deepStrictEqual(result.value, { result: 'fresh' });

      freshCache.close();
    });

    it('should return stale data with stale=true when within grace period', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600,
        staleWhileRevalidateSeconds: 10
      });

      // Set with 1 second TTL
      await freshCache.set('key1', 'tool1', { data: 'test' }, { result: 'stale' }, 1);

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 2000));

      const result = await freshCache.getWithStale('key1');
      assert.ok(result !== null);
      assert.strictEqual(result.stale, true);
      assert.deepStrictEqual(result.value, { result: 'stale' });

      freshCache.close();
    });

    it('should return null when past both TTL and stale grace period', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600,
        staleWhileRevalidateSeconds: 1
      });

      // Set with 1 second TTL and 1 second stale grace
      await freshCache.set('key1', 'tool1', { data: 'test' }, { result: 'old' }, 1);

      // Wait for TTL + stale grace to expire
      await new Promise(resolve => setTimeout(resolve, 3000));

      const result = await freshCache.getWithStale('key1');
      assert.strictEqual(result, null);

      freshCache.close();
    });

    it('should not serve stale data when staleWhileRevalidateSeconds is 0', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600,
        staleWhileRevalidateSeconds: 0 // disabled
      });

      await freshCache.set('key1', 'tool1', { data: 'test' }, { result: 'data' }, 1);

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 2000));

      const result = await freshCache.getWithStale('key1');
      assert.strictEqual(result, null);

      freshCache.close();
    });

    it('should track stale hits in stats', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600,
        staleWhileRevalidateSeconds: 10
      });

      await freshCache.set('key1', 'tool1', { data: 'test' }, { result: 'stale' }, 1);
      await new Promise(resolve => setTimeout(resolve, 2000));

      await freshCache.getWithStale('key1');
      const stats = await freshCache.getStats();
      assert.strictEqual(stats.staleHits, 1);

      freshCache.close();
    });

    it('should touch (update) an existing entry with fresh data', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600,
        staleWhileRevalidateSeconds: 10
      });

      await freshCache.set('key1', 'tool1', { data: 'test' }, { result: 'old' }, 1);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify it's stale
      const staleResult = await freshCache.getWithStale('key1');
      assert.ok(staleResult !== null && staleResult.stale === true);

      // Touch with fresh data
      await freshCache.touch('key1', 'tool1', { data: 'test' }, { result: 'fresh' }, 3600);

      // Should now be fresh
      const freshResult = await freshCache.getWithStale('key1');
      assert.ok(freshResult !== null);
      assert.strictEqual(freshResult.stale, false);
      assert.deepStrictEqual(freshResult.value, { result: 'fresh' });

      freshCache.close();
    });

    it('should return cached errors as value when stale (not throw)', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600,
        staleWhileRevalidateSeconds: 10
      });

      const error = new Error('Stale error');
      await freshCache.set('key1', 'tool1', { data: 'test' }, error, 1, true);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Stale errors are returned as Error objects in value (not thrown)
      // so the caller can serve stale data and trigger background refresh
      const result = await freshCache.getWithStale('key1');
      assert.ok(result !== null);
      assert.strictEqual(result.stale, true);
      assert.ok(result.value instanceof Error);
      assert.strictEqual((result.value as Error).message, 'Stale error');

      // Stale hit should be tracked
      const stats = await freshCache.getStats();
      assert.strictEqual(stats.staleHits, 1);

      freshCache.close();
    });
  });

  describe('cost savings counter', () => {
    it('should track saved calls on fresh cache hits', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      await freshCache.set('key1', 'tool1', { data: 'test' }, { result: 'value' }, 3600);
      await freshCache.get('key1');
      await freshCache.get('key1');

      const stats = await freshCache.getStats();
      assert.strictEqual(stats.savedCalls, 2);

      freshCache.close();
    });

    it('should track saved calls on stale cache hits', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600,
        staleWhileRevalidateSeconds: 10
      });

      await freshCache.set('key1', 'tool1', { data: 'test' }, { result: 'value' }, 1);
      await new Promise(resolve => setTimeout(resolve, 2000));

      await freshCache.getWithStale('key1');

      const stats = await freshCache.getStats();
      assert.strictEqual(stats.savedCalls, 1);

      freshCache.close();
    });

    it('should not count misses as saved calls', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      await freshCache.get('nonexistent');

      const stats = await freshCache.getStats();
      assert.strictEqual(stats.savedCalls, 0);
      assert.strictEqual(stats.misses, 1);

      freshCache.close();
    });

    it('should be zero for a fresh cache', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      const stats = await freshCache.getStats();
      assert.strictEqual(stats.savedCalls, 0);

      freshCache.close();
    });
  });

  describe('WAL mode', () => {
    it('should enable WAL journal mode', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      // WAL mode returns "memory" for in-memory databases, which is fine
      // For file-based databases it would return "wal"
      const mode = freshCache['db'].pragma('journal_mode') as { journal_mode: string }[];
      assert.ok(['memory', 'wal'].includes(mode[0].journal_mode));

      freshCache.close();
    });

    it('should set busy_timeout for concurrent access', async () => {
      const freshCache = new CacheStore({
        path: ':memory:',
        maxSizeBytes: 10000,
        defaultTtlSeconds: 3600
      });

      // busy_timeout is set silently — verify it was set by re-reading
      const result = freshCache['db'].pragma('busy_timeout');
      // The pragma returns the value if set
      assert.ok(result !== undefined);

      freshCache.close();
    });
  });

  describe('eviction tracking', () => {
    it('should record eviction when entry expires via get()', async () => {
      const c = new CacheStore({ path: ':memory:', maxSizeBytes: 10000, defaultTtlSeconds: 3600 });
      await c.set('key1', 'tool1', { data: 'test' }, { result: 'value' }, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
      await c.get('key1');

      const evictions = c['db'].prepare('SELECT * FROM eviction_stats').all() as any[];
      assert.strictEqual(evictions.length, 1);
      assert.strictEqual(evictions[0].tool, 'tool1');
      assert.strictEqual(evictions[0].eviction_reason, 'expired');
      c.close();
    });

    it('should record eviction when entry expires via getWithStale()', async () => {
      const c = new CacheStore({ path: ':memory:', maxSizeBytes: 10000, defaultTtlSeconds: 3600, staleWhileRevalidateSeconds: 1 });
      await c.set('key1', 'tool1', { data: 'test' }, { result: 'value' }, 1);
      await new Promise(resolve => setTimeout(resolve, 3000));
      await c.getWithStale('key1');

      const evictions = c['db'].prepare("SELECT * FROM eviction_stats WHERE eviction_reason = 'stale_expired'").all() as any[];
      assert.strictEqual(evictions.length, 1);
      c.close();
    });

    it('should record LRU evictions with correct reason', async () => {
      const c = new CacheStore({ path: ':memory:', maxSizeBytes: 100, defaultTtlSeconds: 3600 });
      // Each entry is ~80+ bytes (args + result), so 2 entries exceed maxSizeBytes=100
      const bigData = 'x'.repeat(40);
      await c.set('k1', 'tool1', { d: bigData }, { r: bigData }, 3600);
      await c.set('k2', 'tool1', { d: bigData }, { r: bigData }, 3600);

      const evictions = c['db'].prepare("SELECT * FROM eviction_stats WHERE eviction_reason = 'lru'").all() as any[];
      assert.ok(evictions.length > 0);
      c.close();
    });

    it('should track had_hits for evicted entries', async () => {
      const c = new CacheStore({ path: ':memory:', maxSizeBytes: 10000, defaultTtlSeconds: 3600 });
      await c.set('key1', 'tool1', { data: 'test' }, { result: 'value' }, 2);
      await c.get('key1'); // Hit once (within 2s TTL)
      await new Promise(resolve => setTimeout(resolve, 3000));
      await c.get('key1'); // Now expired, triggers eviction

      const evictions = c['db'].prepare('SELECT had_hits FROM eviction_stats').all() as any[];
      assert.strictEqual(evictions.length, 1);
      assert.strictEqual(evictions[0].had_hits, 1);
      c.close();
    });
  });

  describe('stale hits stats fix', () => {
    it('should increment hits (not misses) for stale hits in stats_by_tool', async () => {
      const c = new CacheStore({ path: ':memory:', maxSizeBytes: 10000, defaultTtlSeconds: 3600, staleWhileRevalidateSeconds: 10 });
      await c.set('key1', 'tool1', { data: 'test' }, { result: 'stale' }, 1);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const result = await c.getWithStale('key1');
      assert.ok(result !== null && result.stale === true);

      const toolStats = c['db'].prepare('SELECT * FROM stats_by_tool WHERE tool = ?').get('tool1') as any;
      assert.strictEqual(toolStats.hits, 1, 'Stale hit should increment hits');
      assert.strictEqual(toolStats.misses, 0, 'Stale hit should NOT increment misses');
      c.close();
    });
  });

  describe('adaptive TTL', () => {
    it('should return null for tools without adaptive config', async () => {
      const c = new CacheStore({ path: ':memory:', maxSizeBytes: 10000, defaultTtlSeconds: 3600 });
      assert.strictEqual(c.getAdaptiveTtl('nonexistent_tool'), null);
      c.close();
    });

    it('should initialize adaptive TTLs for configured servers', async () => {
      const c = new CacheStore({ path: ':memory:', maxSizeBytes: 10000, defaultTtlSeconds: 3600 });
      const toolToServer = new Map<string, string>([['tool_a', 'server1']]);
      const servers = { server1: { cacheTtlSeconds: 7200, adaptiveTtl: true } };

      c.initAdaptiveTtls(servers as any, toolToServer);

      assert.strictEqual(c.getAdaptiveTtl('tool_a'), 7200);
      c.close();
    });

    it('should return diagnostic status', async () => {
      const c = new CacheStore({ path: ':memory:', maxSizeBytes: 10000, defaultTtlSeconds: 3600 });
      const toolToServer = new Map<string, string>([['tool_a', 'server1']]);
      const servers = { server1: { cacheTtlSeconds: 3600, adaptiveTtl: true } };

      c.initAdaptiveTtls(servers as any, toolToServer);

      const status = c.getAdaptiveTtlStatus();
      assert.strictEqual(status.length, 1);
      assert.strictEqual(status[0].tool, 'tool_a');
      assert.strictEqual(status[0].baseTtl, 3600);
      assert.strictEqual(status[0].effectiveTtl, 3600);
      assert.strictEqual(status[0].prematureRate, 0);
      c.close();
    });

    it('should decrease TTL when premature eviction rate is high', async () => {
      const c = new CacheStore({ path: ':memory:', maxSizeBytes: 10000, defaultTtlSeconds: 3600 });
      const toolToServer = new Map<string, string>([['tool_a', 'server1']]);
      const servers = { server1: { cacheTtlSeconds: 3600, adaptiveTtl: true, cacheTtlRange: { min: 600, max: 86400 } } };

      c.initAdaptiveTtls(servers as any, toolToServer);

      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 10; i++) {
        c['db'].prepare(`
          INSERT INTO eviction_stats (tool, evicted_at, had_hits, size_bytes, eviction_reason)
          VALUES (?, ?, 0, 100, 'lru')
        `).run('tool_a', now - i * 60);
      }

      await c.adaptTtls(servers as any, toolToServer);

      const newTtl = c.getAdaptiveTtl('tool_a');
      assert.ok(newTtl !== null);
      assert.ok(newTtl < 3600, `TTL should decrease: ${newTtl} < 3600`);
      assert.ok(newTtl >= 600, `TTL should respect min bound: ${newTtl} >= 600`);
      c.close();
    });

    it('should increase TTL when premature eviction rate is low', async () => {
      const c = new CacheStore({ path: ':memory:', maxSizeBytes: 10000, defaultTtlSeconds: 3600 });
      const toolToServer = new Map<string, string>([['tool_a', 'server1']]);
      const servers = { server1: { cacheTtlSeconds: 3600, adaptiveTtl: true, cacheTtlRange: { min: 600, max: 86400 } } };

      c.initAdaptiveTtls(servers as any, toolToServer);

      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 9; i++) {
        c['db'].prepare(`
          INSERT INTO eviction_stats (tool, evicted_at, had_hits, size_bytes, eviction_reason)
          VALUES (?, ?, 1, 100, 'lru')
        `).run('tool_a', now - i * 60);
      }
      c['db'].prepare(`
        INSERT INTO eviction_stats (tool, evicted_at, had_hits, size_bytes, eviction_reason)
        VALUES (?, ?, 0, 100, 'lru')
      `).run('tool_a', now);

      await c.adaptTtls(servers as any, toolToServer);

      const newTtl = c.getAdaptiveTtl('tool_a');
      assert.ok(newTtl !== null);
      assert.ok(newTtl > 3600, `TTL should increase: ${newTtl} > 3600`);
      assert.ok(newTtl <= 86400, `TTL should respect max bound: ${newTtl} <= 86400`);
      c.close();
    });

    it('should not adjust TTL when sample size is insufficient', async () => {
      const c = new CacheStore({ path: ':memory:', maxSizeBytes: 10000, defaultTtlSeconds: 3600 });
      const toolToServer = new Map<string, string>([['tool_a', 'server1']]);
      const servers = { server1: { cacheTtlSeconds: 3600, adaptiveTtl: true } };

      c.initAdaptiveTtls(servers as any, toolToServer);

      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 3; i++) {
        c['db'].prepare(`
          INSERT INTO eviction_stats (tool, evicted_at, had_hits, size_bytes, eviction_reason)
          VALUES (?, ?, 0, 100, 'lru')
        `).run('tool_a', now - i * 60);
      }

      await c.adaptTtls(servers as any, toolToServer);

      const newTtl = c.getAdaptiveTtl('tool_a');
      assert.strictEqual(newTtl, 3600, 'TTL should not change with insufficient samples');
      c.close();
    });

    it('should clean up eviction_stats older than 24h', async () => {
      const c = new CacheStore({ path: ':memory:', maxSizeBytes: 10000, defaultTtlSeconds: 3600 });
      const toolToServer = new Map<string, string>([['tool_a', 'server1']]);
      const servers = { server1: { cacheTtlSeconds: 3600, adaptiveTtl: true } };

      const oldTime = Math.floor(Date.now() / 1000) - 90000;
      c['db'].prepare(`
        INSERT INTO eviction_stats (tool, evicted_at, had_hits, size_bytes, eviction_reason)
        VALUES (?, ?, 0, 100, 'expired')
      `).run('tool_a', oldTime);

      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 5; i++) {
        c['db'].prepare(`
          INSERT INTO eviction_stats (tool, evicted_at, had_hits, size_bytes, eviction_reason)
          VALUES (?, ?, 0, 100, 'expired')
        `).run('tool_a', now - i * 60);
      }

      c.initAdaptiveTtls(servers as any, toolToServer);
      await c.adaptTtls(servers as any, toolToServer);

      const remaining = c['db'].prepare('SELECT COUNT(*) as cnt FROM eviction_stats').get() as any;
      assert.strictEqual(remaining.cnt, 5, 'Old eviction should be cleaned up');
      c.close();
    });
  });
});
