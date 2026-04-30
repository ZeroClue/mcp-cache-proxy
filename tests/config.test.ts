import { describe, it } from 'node:test';
import assert from 'node:assert';
import { loadConfig } from '../src/config.ts';

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
