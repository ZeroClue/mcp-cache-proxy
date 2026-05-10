import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyError, type ClassifiedError } from '../dist/upstream.js';

describe('Error Classification (Phase 1)', () => {
  it('should classify quota_exceeded errors', () => {
    const result = classifyError(new Error('Quota exceeded'));
    assert.strictEqual(result.type, 'quota_exceeded');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify limit errors as quota_exceeded', () => {
    const result = classifyError(new Error('Rate limit exceeded'));
    assert.strictEqual(result.type, 'quota_exceeded');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify 429 errors as quota_exceeded', () => {
    const result = classifyError(new Error('429 Too Many Requests'));
    assert.strictEqual(result.type, 'quota_exceeded');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify timeout errors', () => {
    const result = classifyError(new Error('ETIMEDOUT'));
    assert.strictEqual(result.type, 'timeout');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify connection aborted errors as timeout', () => {
    const result = classifyError(new Error('ECONNABORTED'));
    assert.strictEqual(result.type, 'timeout');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify connection refused errors', () => {
    const result = classifyError(new Error('ECONNREFUSED'));
    assert.strictEqual(result.type, 'connection_refused');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify connection refused message errors', () => {
    const result = classifyError(new Error('Connection refused'));
    assert.strictEqual(result.type, 'connection_refused');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify http 4xx errors', () => {
    const result = classifyError(new Error('400 Bad Request'));
    assert.strictEqual(result.type, 'http_4xx');
    assert.strictEqual(result.retryable, false);
  });

  it('should classify http 401 errors', () => {
    const result = classifyError(new Error('401 Unauthorized'));
    assert.strictEqual(result.type, 'http_4xx');
    assert.strictEqual(result.retryable, false);
  });

  it('should classify http 5xx errors', () => {
    const result = classifyError(new Error('500 Internal Server Error'));
    assert.strictEqual(result.type, 'http_5xx');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify http 503 errors', () => {
    const result = classifyError(new Error('503 Service Unavailable'));
    assert.strictEqual(result.type, 'http_5xx');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify upstream down errors', () => {
    const result = classifyError(new Error('upstream server down'));
    assert.strictEqual(result.type, 'upstream_down');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify unknown errors', () => {
    const result = classifyError(new Error('Some random error'));
    assert.strictEqual(result.type, 'unknown');
    assert.strictEqual(result.retryable, false);
  });

  it('should handle non-Error objects', () => {
    const result = classifyError('string error');
    assert.strictEqual(result.type, 'unknown');
    assert.strictEqual(result.retryable, false);
    assert.ok(result.error instanceof Error);
  });

  it('should handle null errors', () => {
    const result = classifyError(null);
    assert.strictEqual(result.type, 'unknown');
    assert.strictEqual(result.retryable, false);
    assert.ok(result.error instanceof Error);
  });
});

describe('Failover Configuration (Phase 1)', () => {
  it('should load config with failover section', async () => {
    const { loadConfig } = await import('../dist/config.js');
    const config = await loadConfig(new URL('../config.example.failover.json', import.meta.url));
    
    assert.ok(config.failover);
    assert.strictEqual(config.failover.enabled, true);
    assert.strictEqual(config.failover.strategy, 'priority');
    assert.strictEqual(config.failover.cacheByActualServer, true);
    assert.strictEqual(config.failover.maxRetries, 3);
    assert.ok(Array.isArray(config.failover.onErrors));
    assert.ok(config.failover.onErrors.includes('quota_exceeded'));
  });

  it('should have server priorities and tags', async () => {
    const { loadConfig } = await import('../dist/config.js');
    const config = await loadConfig(new URL('../config.example.failover.json', import.meta.url));
    
    assert.ok(config.servers['searxng']);
    assert.strictEqual(config.servers['searxng'].priority, 1);
    assert.deepStrictEqual(config.servers['searxng'].tags, ['web-search']);
    
    assert.ok(config.servers['web-search-prime']);
    assert.strictEqual(config.servers['web-search-prime'].priority, 2);
    assert.deepStrictEqual(config.servers['web-search-prime'].tags, ['web-search']);
  });

  it('should reject invalid failover strategy', async () => {
    const { loadConfig } = await import('../dist/config.js');
    const invalidConfig = {
      servers: {
        test: {
          command: 'test',
          priority: 1,
          tags: ['test']
        }
      },
      cache: {
        path: ':memory:',
        maxSizeBytes: 1000000,
        defaultTtlSeconds: 3600
      },
      mode: 'whitelist' as const,
      failover: {
        enabled: true,
        strategy: 'invalid' as any,
        onErrors: ['quota_exceeded'],
        cacheByActualServer: true,
        maxRetries: 3
      }
    };

    await assert.rejects(
      async () => loadConfigWithFailoverMock(invalidConfig),
      /Invalid failover strategy/
    );
  });

  it('should reject duplicate priorities in tag group', async () => {
    const { loadConfig } = await import('../dist/config.js');
    const invalidConfig = {
      servers: {
        server1: {
          command: 'test1',
          priority: 1,
          tags: ['test']
        },
        server2: {
          command: 'test2',
          priority: 1,
          tags: ['test']
        }
      },
      cache: {
        path: ':memory:',
        maxSizeBytes: 1000000,
        defaultTtlSeconds: 3600
      },
      mode: 'whitelist' as const,
      failover: {
        enabled: true,
        strategy: 'priority' as const,
        onErrors: ['quota_exceeded'],
        cacheByActualServer: true,
        maxRetries: 3
      }
    };

    await assert.rejects(
      async () => loadConfigWithFailoverMock(invalidConfig),
      /Duplicate priorities found in tag group/
    );
  });
});

// Helper function to test config loading with custom config
async function loadConfigWithFailoverMock(config: any): Promise<any> {
  const fs = await import('node:fs');
  const path = '/tmp/test-failover-config-' + Date.now() + '.json';
  await fs.promises.writeFile(path, JSON.stringify(config));
  
  try {
    const { loadConfig } = await import('../dist/config.js');
    return await loadConfig(path);
  } finally {
    await fs.promises.unlink(path).catch(() => {});
  }
}

// Mock UpstreamManager for testing
class MockUpstreamManager {
  private callCounts: Map<string, number> = new Map();
  private failOnServer: Map<string, boolean> = new Map();
  private errorOnServer: Map<string, Error> = new Map();
  private resultOnServer: Map<string, unknown> = new Map();

  setFail(serverName: string, shouldFail: boolean) {
    this.failOnServer.set(serverName, shouldFail);
  }

  setError(serverName: string, error: Error) {
    this.errorOnServer.set(serverName, error);
  }

  setResult(serverName: string, result: unknown) {
    this.resultOnServer.set(serverName, result);
  }

  getCallCount(serverName: string): number {
    return this.callCounts.get(serverName) || 0;
  }

  getTotalCalls(): number {
    return Array.from(this.callCounts.values()).reduce((a, b) => a + b, 0);
  }

  async callTool(serverName: string, toolName: string, args: unknown): Promise<unknown> {
    this.callCounts.set(serverName, (this.callCounts.get(serverName) || 0) + 1);

    if (this.errorOnServer.has(serverName)) {
      throw this.errorOnServer.get(serverName)!;
    }

    if (this.failOnServer.get(serverName)) {
      throw new Error(`Server ${serverName} failed`);
    }

    return this.resultOnServer.get(serverName) || { server: serverName, tool: toolName, args };
  }

  close() {}
}

describe('Proxy Failover Integration (Phase 1)', () => {
  // Helper to create a mock cache with all required methods
  function createMockCache() {
    return {
      get: async () => null,
      getWithStale: async () => null, // Return null for cache miss
      getAdaptiveTtl: () => undefined,
      set: async () => {},
      touch: async () => {}
    };
  }

  it('should not failover when primary succeeds', async () => {
    const { ToolRouter } = await import('../dist/proxy.js');
    const mockCache = createMockCache();
    const mockUpstream = new MockUpstreamManager();

    const servers = {
      searxng: {
        command: 'echo',
        args: ['searxng'],
        priority: 1,
        tags: ['web-search'],
        cacheTtlSeconds: 3600
      },
      'web-search-prime': {
        command: 'echo',
        args: ['prime'],
        priority: 2,
        tags: ['web-search'],
        cacheTtlSeconds: 3600
      }
    };

    const failoverConfig = {
      enabled: true,
      strategy: 'priority' as const,
      onErrors: ['quota_exceeded', 'timeout', 'connection_refused', 'http_5xx'],
      cacheByActualServer: true,
      maxRetries: 3
    };

    const router = new ToolRouter(mockCache, servers, 'whitelist', 300, failoverConfig, mockUpstream);
    
    router.registerTool({
      name: 'searxng_web_search',
      description: 'Search web',
      inputSchema: { type: 'object' }
    }, 'searxng');
    
    router.registerTool({
      name: 'web_search_prime',
      description: 'Search web',
      inputSchema: { type: 'object' }
    }, 'web-search-prime');

    mockUpstream.setResult('searxng', { results: [] });
    
    const result = await router.callTool('searxng_web_search', { query: 'test' }, async () => { throw new Error('Should not be called'); });
    
    assert.strictEqual(mockUpstream.getCallCount('searxng'), 1);
    assert.strictEqual(mockUpstream.getCallCount('web-search-prime'), 0);
    assert.deepStrictEqual(result, { results: [] });
  });

  it('should failover from primary to secondary when primary fails', async () => {
    const { ToolRouter } = await import('../dist/proxy.js');
    const mockCache = createMockCache();
    const mockUpstream = new MockUpstreamManager();

    const servers = {
      searxng: {
        command: 'echo',
        args: ['searxng'],
        priority: 1,
        tags: ['web-search'],
        cacheTtlSeconds: 3600
      },
      'web-search-prime': {
        command: 'echo',
        args: ['prime'],
        priority: 2,
        tags: ['web-search'],
        cacheTtlSeconds: 3600
      }
    };

    const failoverConfig = {
      enabled: true,
      strategy: 'priority' as const,
      onErrors: ['quota_exceeded'],
      cacheByActualServer: true,
      maxRetries: 3,
      toolMappings: {
        'web-search-prime': {
          'web_search_prime': 'searxng:searxng_web_search'
        }
      }
    };

    const router = new ToolRouter(mockCache, servers, 'whitelist', 300, failoverConfig, mockUpstream);
    
    router.registerTool({
      name: 'searxng_web_search',
      description: 'Search web',
      inputSchema: { type: 'object' }
    }, 'searxng');
    
    router.registerTool({
      name: 'web_search_prime',
      description: 'Search web',
      inputSchema: { type: 'object' }
    }, 'web-search-prime');

    mockUpstream.setError('web-search-prime', new Error('Quota exceeded'));
    mockUpstream.setResult('searxng', { results: [] });
    
    const result = await router.callTool('web_search_prime', { query: 'test' }, async () => { throw new Error('Should not be called'); });
    
    assert.strictEqual(mockUpstream.getCallCount('web-search-prime'), 1);
    assert.strictEqual(mockUpstream.getCallCount('searxng'), 1);
    assert.deepStrictEqual(result, { results: [] });
  });

  it('should fail when all servers fail', async () => {
    const { ToolRouter } = await import('../dist/proxy.js');
    const mockCache = createMockCache();
    const mockUpstream = new MockUpstreamManager();

    const servers = {
      searxng: {
        command: 'echo',
        args: ['searxng'],
        priority: 1,
        tags: ['web-search'],
        cacheTtlSeconds: 3600
      },
      'web-search-prime': {
        command: 'echo',
        args: ['prime'],
        priority: 2,
        tags: ['web-search'],
        cacheTtlSeconds: 3600
      }
    };

    const failoverConfig = {
      enabled: true,
      strategy: 'priority' as const,
      onErrors: ['quota_exceeded', 'timeout', 'connection_refused', 'http_5xx'],
      cacheByActualServer: true,
      maxRetries: 3,
      toolMappings: {
        'web-search-prime': {
          'web_search_prime': 'searxng:searxng_web_search'
        }
      }
    };

    const router = new ToolRouter(mockCache, servers, 'whitelist', 300, failoverConfig, mockUpstream);
    
    router.registerTool({
      name: 'searxng_web_search',
      description: 'Search web',
      inputSchema: { type: 'object' }
    }, 'searxng');
    
    router.registerTool({
      name: 'web_search_prime',
      description: 'Search web',
      inputSchema: { type: 'object' }
    }, 'web-search-prime');

    mockUpstream.setError('web-search-prime', new Error('Quota exceeded'));
    mockUpstream.setError('searxng', new Error('Connection refused'));
    
    await assert.rejects(
      () => router.callTool('web_search_prime', { query: 'test' }, async () => { throw new Error('Should not be called'); }),
      /Connection refused/
    );
    
    assert.strictEqual(mockUpstream.getCallCount('web-search-prime'), 1);
    assert.strictEqual(mockUpstream.getCallCount('searxng'), 1);
  });

  it('should not failover on non-failover error', async () => {
    const { ToolRouter } = await import('../dist/proxy.js');
    const mockCache = createMockCache();
    const mockUpstream = new MockUpstreamManager();

    const servers = {
      searxng: {
        command: 'echo',
        args: ['searxng'],
        priority: 1,
        tags: ['web-search'],
        cacheTtlSeconds: 3600
      },
      'web-search-prime': {
        command: 'echo',
        args: ['prime'],
        priority: 2,
        tags: ['web-search'],
        cacheTtlSeconds: 3600
      }
    };

    const failoverConfig = {
      enabled: true,
      strategy: 'priority' as const,
      onErrors: ['quota_exceeded', 'timeout'], // 401 not included
      cacheByActualServer: true,
      maxRetries: 3
    };

    const router = new ToolRouter(mockCache, servers, 'whitelist', 300, failoverConfig, mockUpstream);
    
    router.registerTool({
      name: 'searxng_web_search',
      description: 'Search web',
      inputSchema: { type: 'object' }
    }, 'searxng');

    mockUpstream.setError('searxng', new Error('401 Unauthorized'));
    
    await assert.rejects(
      () => router.callTool('searxng_web_search', { query: 'test' }, async () => { throw new Error('Should not be called'); }),
      /401/
    );
    
    assert.strictEqual(mockUpstream.getCallCount('searxng'), 1); // Only called once
  });

  it('should not failover when failover is disabled', async () => {
    const { ToolRouter } = await import('../dist/proxy.js');
    const mockCache = createMockCache();
    const mockUpstream = new MockUpstreamManager();

    const servers = {
      searxng: {
        command: 'echo',
        args: ['searxng'],
        priority: 1,
        tags: ['web-search'],
        cacheTtlSeconds: 3600
      },
      'web-search-prime': {
        command: 'echo',
        args: ['prime'],
        priority: 2,
        tags: ['web-search'],
        cacheTtlSeconds: 3600
      }
    };

    const failoverConfig = {
      enabled: false, // Disabled
      strategy: 'priority' as const,
      onErrors: ['quota_exceeded'],
      cacheByActualServer: true,
      maxRetries: 3
    };

    const router = new ToolRouter(mockCache, servers, 'whitelist', 300, failoverConfig, mockUpstream);
    
    router.registerTool({
      name: 'searxng_web_search',
      description: 'Search web',
      inputSchema: { type: 'object' }
    }, 'searxng');

    mockUpstream.setError('searxng', new Error('Quota exceeded'));
    
    await assert.rejects(
      () => router.callTool('searxng_web_search', { query: 'test' }, async () => { throw new Error('Should not be called'); }),
      /Quota exceeded/
    );
    
    assert.strictEqual(mockUpstream.getCallCount('searxng'), 1); // Only called once
  });

  it('should respect maxRetries limit', async () => {
    const { ToolRouter } = await import('../dist/proxy.js');
    const mockCache = createMockCache();
    const mockUpstream = new MockUpstreamManager();

    const servers = {
      server1: {
        command: 'echo',
        args: ['s1'],
        priority: 1,
        tags: ['web-search'],
        cacheTtlSeconds: 3600
      },
      server2: {
        command: 'echo',
        args: ['s2'],
        priority: 2,
        tags: ['web-search'],
        cacheTtlSeconds: 3600
      },
      server3: {
        command: 'echo',
        args: ['s3'],
        priority: 3,
        tags: ['web-search'],
        cacheTtlSeconds: 3600
      }
    };

    const failoverConfig = {
      enabled: true,
      strategy: 'priority' as const,
      onErrors: ['quota_exceeded'],
      cacheByActualServer: true,
      maxRetries: 2 // Only try first 2 servers
    };

    const router = new ToolRouter(mockCache, servers, 'whitelist', 300, failoverConfig, mockUpstream);
    
    router.registerTool({
      name: 'web_search',
      description: 'Search web',
      inputSchema: { type: 'object' }
    }, 'server1');
    
    router.registerTool({
      name: 'web_search',
      description: 'Search web',
      inputSchema: { type: 'object' }
    }, 'server2');
    
    router.registerTool({
      name: 'web_search',
      description: 'Search web',
      inputSchema: { type: 'object' }
    }, 'server3');

    mockUpstream.setError('server1', new Error('Quota exceeded'));
    mockUpstream.setError('server2', new Error('Quota exceeded'));
    mockUpstream.setError('server3', new Error('Quota exceeded'));
    
    await assert.rejects(
      () => router.callTool('web_search', { query: 'test' }, async () => { throw new Error('Should not be called'); }),
      /Quota exceeded/
    );
    
    // With maxRetries=2, we should have tried 2 servers total
    const totalCalls = mockUpstream.getCallCount('server1') + 
                      mockUpstream.getCallCount('server2') + 
                      mockUpstream.getCallCount('server3');
    assert.strictEqual(totalCalls, 2, `Expected 2 total calls, got ${totalCalls}`);
  });
});
