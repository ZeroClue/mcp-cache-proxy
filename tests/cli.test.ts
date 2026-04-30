import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { parseCliArgs, handleCliCommand } from '../src/cli.ts';
import { CacheStore } from '../src/cache.ts';

describe('parseCliArgs', () => {
  it('should parse empty args', () => {
    const args = parseCliArgs([]);
    assert.strictEqual(args.mode, 'server');
  });

  it('should parse --stats', () => {
    const args = parseCliArgs(['--stats']);
    assert.strictEqual(args.mode, 'stats');
  });

  it('should parse --flush', () => {
    const args = parseCliArgs(['--flush']);
    assert.strictEqual(args.mode, 'flush');
    assert.strictEqual(args.tool, undefined);
  });

  it('should parse --flush with tool', () => {
    const args = parseCliArgs(['--flush', 'search-prime']);
    assert.strictEqual(args.mode, 'flush');
    assert.strictEqual(args.tool, 'search-prime');
  });

  it('should parse --new', () => {
    const args = parseCliArgs(['--new']);
    assert.strictEqual(args.mode, 'new');
  });

  it('should parse --config', () => {
    const args = parseCliArgs(['--config', '/path/to/config.json']);
    assert.strictEqual(args.configPath, '/path/to/config.json');
  });
});

describe('handleCliCommand', () => {
  let cache: CacheStore;

  before(() => {
    cache = new CacheStore({ path: ':memory:', maxSizeBytes: 1000, defaultTtlSeconds: 3600 });
  });

  after(() => {
    cache.close();
  });

  it('should return stats for --stats mode', async () => {
    await cache.set('test_key', 'test_tool', { query: 'test' }, { result: 'data' }, 3600);
    const result = await handleCliCommand({ mode: 'stats' }, cache);
    assert.strictEqual(result.exitCode, 0);
    const stats = JSON.parse(result.output);
    assert.strictEqual(stats.cached, 1);
  });

  it('should flush all cache for --flush mode', async () => {
    await cache.set('flush_test_key', 'test_tool', { query: 'test' }, { result: 'data' }, 3600);
    const result = await handleCliCommand({ mode: 'flush' }, cache);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.output, 'Flushed all cache');
    const value = await cache.get('flush_test_key');
    assert.strictEqual(value, null);
  });

  it('should flush specific tool cache for --flush tool mode', async () => {
    await cache.set('flush_tool_a', 'tool_a', { query: 'test' }, { result: 'a' }, 3600);
    await cache.set('flush_tool_b', 'tool_b', { query: 'test' }, { result: 'b' }, 3600);
    const result = await handleCliCommand({ mode: 'flush', tool: 'tool_a' }, cache);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.output, 'Flushed cache for: tool_a');
    assert.strictEqual(await cache.get('flush_tool_a'), null);
    assert.deepStrictEqual(await cache.get('flush_tool_b'), { result: 'b' });
  });

  it('should recreate cache for --new mode', async () => {
    await cache.set('recreate_key', 'test_tool', { query: 'test' }, { result: 'data' }, 3600);
    const result = await handleCliCommand({ mode: 'new' }, cache);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.output, 'Cache database recreated');
    // After recreation, the cache should be empty
    const stats = await cache.getStats();
    assert.strictEqual(stats.cached, 0);
  });

  it('should return empty output for server mode', async () => {
    const result = await handleCliCommand({ mode: 'server' }, cache);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.output, '');
  });
});
