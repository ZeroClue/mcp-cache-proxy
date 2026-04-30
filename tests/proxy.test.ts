import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ToolRouter } from '../dist/proxy.js';
import type { CacheStore } from '../dist/cache.js';

describe('ToolRouter', () => {
  it('should return cached result on hit', async () => {
    const mockCache = {
      get: async (key: string) => key === 'expected-key' ? { cached: true } : null,
      set: async () => {}
    } as unknown as CacheStore;

    const router = new ToolRouter(mockCache, {}, 'whitelist');
    const upstream = async () => ({ fresh: true });

    const result = await router.callTool('test-tool', { query: 'test' }, upstream);
    assert.deepStrictEqual(result, { fresh: true });
  });

  it('should pass through for non-cacheable tools in whitelist mode', async () => {
    const mockCache = {
      get: async () => null,
      set: async () => {}
    } as unknown as CacheStore;

    const router = new ToolRouter(mockCache, {}, 'whitelist');
    let called = false;
    const upstream = async () => { called = true; return { fresh: true }; };

    await router.callTool('Edit', { path: 'test.txt' }, upstream);
    assert.strictEqual(called, true);
  });

  it('should identify cacheable tools in whitelist mode', () => {
    const mockCache = {} as unknown as CacheStore;
    const router = new ToolRouter(mockCache, {
      'search-prime': { command: 'npx', args: ['-y', '@zai-mcp/web-search-prime'] }
    }, 'whitelist');

    assert.strictEqual(router.isCacheable('search_prime_web_search'), true);
    assert.strictEqual(router.isCacheable('Edit'), false);
  });

  it('should identify cacheable tools in blacklist mode', () => {
    const mockCache = {} as unknown as CacheStore;
    const router = new ToolRouter(mockCache, {}, 'blacklist');

    assert.strictEqual(router.isCacheable('search_prime_web_search'), true);
    assert.strictEqual(router.isCacheable('Edit'), false);
  });

  it('should register and retrieve tools', () => {
    const mockCache = {} as unknown as CacheStore;
    const router = new ToolRouter(mockCache, {}, 'whitelist');

    router.registerTool({
      name: 'test_tool',
      description: 'Test tool',
      inputSchema: { type: 'object' }
    });

    const tools = router.getTools();
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, 'test_tool');
  });

  it('should find server for tool by name prefix', () => {
    const mockCache = {} as unknown as CacheStore;
    const router = new ToolRouter(mockCache, {
      'search-prime': { command: 'npx', args: [] }
    }, 'whitelist');

    const server = router.findServerForTool('search_prime_web_search');
    assert.strictEqual(server, 'search-prime');
  });

  it('should handle errors in upstream calls gracefully', async () => {
    const mockCache = {
      get: async () => null,
      set: async () => {}
    } as unknown as CacheStore;

    const router = new ToolRouter(mockCache, {}, 'whitelist');
    const upstream = async () => {
      throw new Error('Upstream connection failed');
    };

    // The router should propagate the error
    await assert.rejects(
      async () => await router.callTool('test-tool', { query: 'test' }, upstream),
      { message: 'Upstream connection failed' }
    );
  });
});
