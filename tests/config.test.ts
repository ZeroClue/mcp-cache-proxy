import { describe, it } from 'node:test';
import assert from 'node:assert';
import { loadConfig, mergeConfigs } from '../src/config.ts';

describe('loadConfig', () => {
  it('should load config from example file', async () => {
    const config = await loadConfig(new URL('../config.example.json', import.meta.url));
    assert.strictEqual(config.servers['search-prime'].command, 'npx');
    assert.strictEqual(config.mode, 'whitelist');
    assert.strictEqual(config.extendGlobal, true);
  });

  it('should have default cache values', async () => {
    const config = await loadConfig(new URL('../config.example.json', import.meta.url));
    assert.ok(config.cache.path);
    assert.strictEqual(config.cache.maxSizeBytes, 104857600);
    assert.strictEqual(config.cache.defaultTtlSeconds, 43200);
  });

  it('should include server TTL overrides', async () => {
    const config = await loadConfig(new URL('../config.example.json', import.meta.url));
    assert.strictEqual(config.servers['search-prime'].cacheTtlSeconds, 86400);
  });
});

describe('mergeConfigs', () => {
  it('should deep merge configs', () => {
    const base = {
      servers: {
        'search-prime': {
          command: 'npx',
          args: ['-y', '@zai-mcp/web-search-prime'],
          cacheTtlSeconds: 86400
        },
        'web-reader': {
          command: 'npx',
          args: ['-y', '@zai-mcp/web-reader'],
          cacheTtlSeconds: 21600
        }
      },
      cache: {
        path: '~/.mcp-cache-proxy/cache.db',
        maxSizeBytes: 104857600,
        defaultTtlSeconds: 43200
      },
      mode: 'whitelist' as const,
      extendGlobal: true
    };

    const override = {
      servers: {
        'search-prime': {
          command: 'node',
          args: ['/custom/path/search.js'],
          cacheTtlSeconds: 12345
        }
      },
      cache: {
        maxSizeBytes: 209715200
      },
      mode: 'blacklist' as const
    };

    const merged = mergeConfigs(base, override);

    // Server should be completely replaced, not merged
    assert.strictEqual(merged.servers['search-prime'].command, 'node');
    assert.strictEqual(merged.servers['search-prime'].args[0], '/custom/path/search.js');
    assert.strictEqual(merged.servers['search-prime'].cacheTtlSeconds, 12345);

    // Other servers should remain
    assert.strictEqual(merged.servers['web-reader'].command, 'npx');

    // Cache config should be merged
    assert.strictEqual(merged.cache.path, '~/.mcp-cache-proxy/cache.db'); // from base
    assert.strictEqual(merged.cache.maxSizeBytes, 209715200); // from override
    assert.strictEqual(merged.cache.defaultTtlSeconds, 43200); // from base

    // Mode should be overridden
    assert.strictEqual(merged.mode, 'blacklist');

    // extendGlobal should be preserved
    assert.strictEqual(merged.extendGlobal, true);
  });

  it('should add new servers without removing existing ones', () => {
    const base = {
      servers: {
        'search-prime': {
          command: 'npx',
          args: ['-y', '@zai-mcp/web-search-prime']
        }
      },
      cache: {
        path: '~/.mcp-cache-proxy/cache.db',
        maxSizeBytes: 104857600,
        defaultTtlSeconds: 43200
      },
      mode: 'whitelist' as const
    };

    const override = {
      servers: {
        'web-reader': {
          command: 'npx',
          args: ['-y', '@zai-mcp/web-reader']
        }
      }
    };

    const merged = mergeConfigs(base, override);

    // Both servers should be present
    assert.strictEqual(merged.servers['search-prime'].command, 'npx');
    assert.strictEqual(merged.servers['web-reader'].command, 'npx');
  });

  it('should handle empty override', () => {
    const base = {
      servers: {
        'search-prime': {
          command: 'npx',
          args: ['-y', '@zai-mcp/web-search-prime']
        }
      },
      cache: {
        path: '~/.mcp-cache-proxy/cache.db',
        maxSizeBytes: 104857600,
        defaultTtlSeconds: 43200
      },
      mode: 'whitelist' as const,
      extendGlobal: true
    };

    const override = {};

    const merged = mergeConfigs(base, override);

    // Should be identical to base
    assert.strictEqual(merged.servers['search-prime'].command, 'npx');
    assert.strictEqual(merged.mode, 'whitelist');
    assert.strictEqual(merged.extendGlobal, true);
  });
});
