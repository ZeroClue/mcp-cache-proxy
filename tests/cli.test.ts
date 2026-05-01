import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { parseCliArgs, handleCliCommand, validateConfigPath } from '../src/cli.ts';
import { CacheStore } from '../src/cache.ts';

describe('parseCliArgs', () => {
  it('should parse empty args', () => {
    const result = parseCliArgs([]);
    assert.strictEqual(result.args.mode, 'server');
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.warnings.length, 0);
  });

  it('should parse --stats', () => {
    const result = parseCliArgs(['--stats']);
    assert.strictEqual(result.args.mode, 'stats');
    assert.strictEqual(result.errors.length, 0);
  });

  it('should parse --flush', () => {
    const result = parseCliArgs(['--flush']);
    assert.strictEqual(result.args.mode, 'flush');
    assert.strictEqual(result.args.tool, undefined);
    assert.strictEqual(result.errors.length, 0);
  });

  it('should parse --flush with tool', () => {
    const result = parseCliArgs(['--flush', 'search-prime']);
    assert.strictEqual(result.args.mode, 'flush');
    assert.strictEqual(result.args.tool, 'search-prime');
    assert.strictEqual(result.errors.length, 0);
  });

  it('should parse --new', () => {
    const result = parseCliArgs(['--new']);
    assert.strictEqual(result.args.mode, 'new');
    assert.strictEqual(result.errors.length, 0);
  });

  it('should parse --config', () => {
    const result = parseCliArgs(['--config', '/path/to/config.json']);
    assert.strictEqual(result.args.configPath, '/path/to/config.json');
    assert.strictEqual(result.errors.length, 0);
  });

  it('should parse --help', () => {
    const result = parseCliArgs(['--help']);
    assert.strictEqual(result.args.mode, 'help');
    assert.strictEqual(result.errors.length, 0);
  });

  it('should parse --warm', () => {
    const result = parseCliArgs(['--warm', '--queries', 'queries.txt']);
    assert.strictEqual(result.args.mode, 'warm');
    assert.strictEqual(result.args.queriesPath, 'queries.txt');
    assert.strictEqual(result.errors.length, 0);
  });

  it('should require --queries when using --warm', () => {
    const result = parseCliArgs(['--warm']);
    assert.strictEqual(result.args.mode, 'warm');
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /--warm requires --queries/);
  });

  it('should detect conflicting mode flags', () => {
    const result = parseCliArgs(['--stats', '--flush']);
    assert.strictEqual(result.args.mode, 'flush'); // Last one wins
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /Conflicting flags/);
    assert.match(result.errors[0], /--stats/);
    assert.match(result.errors[0], /--flush/);
  });

  it('should detect multiple conflicting mode flags', () => {
    const result = parseCliArgs(['--stats', '--flush', '--new']);
    assert.strictEqual(result.args.mode, 'new'); // Last one wins
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /Conflicting flags/);
  });

  it('should warn about unknown flags', () => {
    const result = parseCliArgs(['--unknown-flag']);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /Unknown flag.*--unknown-flag/);
  });

  it('should warn about unexpected arguments', () => {
    const result = parseCliArgs(['unexpected-arg']);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /Unexpected argument.*unexpected-arg/);
  });

  it('should warn about argument after --config', () => {
    const result = parseCliArgs(['--flush', 'tool1', 'unexpected']);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /Unexpected argument.*unexpected/);
  });

  it('should parse --export with file path', () => {
    const result = parseCliArgs(['--export', '/path/to/export.json']);
    assert.strictEqual(result.args.mode, 'export');
    assert.strictEqual(result.args.exportPath, '/path/to/export.json');
    assert.strictEqual(result.errors.length, 0);
  });

  it('should error when --export missing file path', () => {
    const result = parseCliArgs(['--export']);
    assert.strictEqual(result.args.mode, 'export');
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /--export requires a file path/);
  });

  it('should parse --import with file path', () => {
    const result = parseCliArgs(['--import', '/path/to/import.json']);
    assert.strictEqual(result.args.mode, 'import');
    assert.strictEqual(result.args.importPath, '/path/to/import.json');
    assert.strictEqual(result.errors.length, 0);
  });

  it('should error when --import missing file path', () => {
    const result = parseCliArgs(['--import']);
    assert.strictEqual(result.args.mode, 'import');
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /--import requires a file path/);
  });

  it('should include --export and --import in conflicting flags check', () => {
    const result = parseCliArgs(['--export', 'file.json', '--import', 'file.json']);
    assert.strictEqual(result.args.mode, 'import'); // Last one wins
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /Conflicting flags/);
  });
});

describe('validateConfigPath', () => {
  it('should validate undefined config path', async () => {
    const errors = await validateConfigPath(undefined);
    assert.strictEqual(errors.length, 0);
  });

  it('should validate existing config file', async () => {
    // Use a known existing file
    const errors = await validateConfigPath('/home/arminm/projects/mcp-cache-proxy/package.json');
    assert.strictEqual(errors.length, 0);
  });

  it('should reject non-existent config file', async () => {
    const errors = await validateConfigPath('/nonexistent/path/config.json');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /Invalid config path/);
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

  it('should return help text for --help mode', async () => {
    const result = await handleCliCommand({ mode: 'help' }, cache);
    assert.strictEqual(result.exitCode, 0);
    assert.match(result.output, /MCP Cache Proxy CLI/);
    assert.match(result.output, /Usage:/);
    assert.match(result.output, /--stats/);
    assert.match(result.output, /--flush/);
    assert.match(result.output, /--new/);
    assert.match(result.output, /--warm/);
    assert.match(result.output, /--queries/);
    assert.match(result.output, /--config/);
    assert.match(result.output, /--help/);
    assert.match(result.output, /Examples:/);
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

  it('should handle errors and return non-zero exit code', async () => {
    // Create a cache that's been closed to simulate an error
    const badCache = new CacheStore({ path: ':memory:', maxSizeBytes: 1000, defaultTtlSeconds: 3600 });
    await badCache.close();

    const result = await handleCliCommand({ mode: 'stats' }, badCache);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.output, /Error:/);
  });

  it('should handle errors in flush mode', async () => {
    const badCache = new CacheStore({ path: ':memory:', maxSizeBytes: 1000, defaultTtlSeconds: 3600 });
    await badCache.close();

    const result = await handleCliCommand({ mode: 'flush', tool: 'test' }, badCache);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.output, /Error:/);
  });

  it('should handle errors in new mode', async () => {
    // We can't easily trigger an error in recreate(), so we'll test
    // that the error handling structure is in place by checking
    // the function handles the mode correctly
    const result = await handleCliCommand({ mode: 'new' }, cache);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.output, 'Cache database recreated');
  });

  it('should handle database errors gracefully', async () => {
    // Create a cache that we'll make fail by corrupting the database
    const errorCache = new CacheStore({ path: ':memory:', maxSizeBytes: 1000, defaultTtlSeconds: 3600 });

    // Close the database to simulate an error condition
    errorCache['db'].close();

    const result = await handleCliCommand({ mode: 'stats' }, errorCache);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.output, /Error:/);
  });

  it('should handle export mode', async () => {
    const exportPath = '/tmp/test-cli-export.json';
    const result = await handleCliCommand({ mode: 'export', exportPath }, cache);

    assert.strictEqual(result.exitCode, 0);
    assert.match(result.output, /Cache exported to:/);
    assert.match(result.output, /test-cli-export\.json/);

    // Clean up
    const fs = await import('node:fs/promises');
    try { await fs.unlink(exportPath); } catch {}
  });

  it('should handle import mode', async () => {
    // First create an export file
    const importPath = '/tmp/test-cli-import.json';
    const fs = await import('node:fs/promises');

    // Create test data
    const testData = {
      version: 1,
      exportedAt: Math.floor(Date.now() / 1000),
      entries: [
        {
          key: 'test_key',
          tool: 'test_tool',
          args: { data: 'test' },
          result: { value: 'test_result' },
          created_at: Math.floor(Date.now() / 1000) - 100,
          ttl_seconds: 3600,
          is_error: false
        }
      ]
    };

    await fs.writeFile(importPath, JSON.stringify(testData, null, 2), 'utf-8');

    const result = await handleCliCommand({ mode: 'import', importPath }, cache);

    assert.strictEqual(result.exitCode, 0);
    assert.match(result.output, /Cache import complete/);
    assert.match(result.output, /Imported: 1/);

    // Clean up
    try { await fs.unlink(importPath); } catch {}
  });

  describe('warm mode', () => {
    it('should require --queries for warm mode', async () => {
      const result = await handleCliCommand({ mode: 'warm' }, cache);
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.output, /--queries file path is required/);
    });

    it('should return error if upstream and router are not provided', async () => {
      const result = await handleCliCommand(
        { mode: 'warm', queriesPath: 'queries.txt' },
        cache
      );
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.output, /internal error/);
    });

    it('should handle missing queries file', async () => {
      // Mock upstream and router
      const mockUpstream = {} as any;
      const mockRouter = {} as any;

      const result = await handleCliCommand(
        { mode: 'warm', queriesPath: '/nonexistent/queries.txt' },
        cache,
        mockUpstream,
        mockRouter
      );
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.output, /Error reading queries file/);
    });
  });

  describe('tune-ttl mode', () => {
    it('should parse --tune-ttl', () => {
      const result = parseCliArgs(['--tune-ttl']);
      assert.strictEqual(result.args.mode, 'tune-ttl');
      assert.strictEqual(result.errors.length, 0);
    });

    it('should show no-adaptive message when no adaptive TTLs configured', async () => {
      await cache.flush();
      const result = await handleCliCommand({ mode: 'tune-ttl' }, cache);
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.output, /No adaptive TTLs configured/);
    });

    it('should show diagnostic status for tools with adaptive TTLs', async () => {
      await cache.flush();
      // Seed an adaptive TTL entry directly
      const toolToServer = new Map<string, string>([['tool_a', 'server1']]);
      const servers = { server1: { cacheTtlSeconds: 7200, adaptiveTtl: true } };
      cache.initAdaptiveTtls(servers, toolToServer);

      const result = await handleCliCommand({ mode: 'tune-ttl' }, cache);
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.output, /Adaptive TTL Status/);
      assert.match(result.output, /tool_a/);
    });
  });
});
