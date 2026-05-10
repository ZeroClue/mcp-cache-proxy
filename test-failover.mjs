#!/usr/bin/env node

/**
 * Test script for MCP Cache Proxy failover functionality
 * Tests:
 * 1. SearXNG direct call (should work)
 * 2. Web-search-prime call (should fail over to SearXNG due to quota exhaustion)
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './dist/config.js';
import { UpstreamManager } from './dist/upstream.js';
import { ToolRouter } from './dist/proxy.js';
import { CacheStore } from './dist/cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI color codes for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
};

function log(message, color = 'reset') {
  console.error(`${colors[color]}${message}${colors.reset}`);
}

async function testFailover() {
  log('=== MCP Cache Proxy Failover Test ===', 'blue');
  log('');

  try {
    // Load config
    log('Loading configuration...', 'yellow');
    const configPath = join(process.env.HOME || '.', '.mcp-cache-proxy', 'config.json');
    const config = await loadConfig(configPath);

    log(`Failover enabled: ${config.failover?.enabled}`, config.failover?.enabled ? 'green' : 'red');
    log(`Failover strategy: ${config.failover?.strategy}`, 'blue');
    log('');

    // Create cache
    log('Initializing cache...', 'yellow');
    const cache = new CacheStore(config.cache);
    log('Cache initialized', 'green');
    log('');

    // Create upstream manager
    log('Connecting to upstream servers...', 'yellow');
    const upstreamManager = new UpstreamManager();
    log('Upstream manager created', 'green');
    log('');

    // Connect to servers
    const servers = Object.keys(config.servers);
    for (const serverName of servers) {
      try {
        log(`Connecting to ${serverName}...`, 'yellow');
        await upstreamManager.connect(serverName, config.servers[serverName]);
        log(`✓ Connected to ${serverName}`, 'green');
      } catch (error) {
        log(`✗ Failed to connect to ${serverName}: ${error.message}`, 'red');
      }
    }
    log('');

    // Create tool router
    log('Creating tool router...', 'yellow');
    const router = new ToolRouter(
      cache,
      config.servers,
      config.mode,
      config.cache.defaultTtlSeconds,
      config.failover
    );
    log('Tool router created', 'green');
    log('');

    // Register tools from servers
    log('Registering tools...', 'yellow');
    for (const serverName of servers) {
      try {
        const client = upstreamManager.getClient(serverName);
        const response = await client.listTools();
        for (const tool of response.tools) {
          router.registerTool(tool, serverName);
        }
        log(`✓ Registered ${response.tools.length} tools from ${serverName}`, 'green');
      } catch (error) {
        log(`✗ Failed to list tools from ${serverName}: ${error.message}`, 'red');
      }
    }
    log('');

    // Test 1: Direct SearXNG call
    log('=== Test 1: Direct SearXNG call (searxng_web_search) ===', 'magenta');
    try {
      const result = await router.callTool(
        'searxng_web_search',
        { query: 'MCP Cache Proxy test' },
        async () => {
          const serverName = 'searxng';
          const client = upstreamManager.getClient(serverName);
          return await client.callTool({
            name: 'searxng_web_search',
            arguments: { query: 'MCP Cache Proxy test' }
          });
        }
      );
      log('✓ Test 1 PASSED: SearXNG call succeeded', 'green');
      log(`Result type: ${typeof result}`, 'blue');
      log(`Result keys: ${Object.keys(result).join(', ')}`, 'blue');
    } catch (error) {
      log(`✗ Test 1 FAILED: ${error.message}`, 'red');
    }
    log('');

    // Test 2: Web-search-prime call (should fail over to SearXNG)
    log('=== Test 2: Web-search-prime call (should fail over to SearXNG) ===', 'magenta');
    try {
      const result = await router.callTool(
        'web_search_prime',
        { query: 'MCP Cache Proxy failover test' },
        async () => {
          const serverName = 'web-search-prime';
          const client = upstreamManager.getClient(serverName);
          return await client.callTool({
            name: 'web_search_prime',
            arguments: { query: 'MCP Cache Proxy failover test' }
          });
        }
      );
      log('✓ Test 2 PASSED: Call succeeded (likely failed over)', 'green');
      log(`Result type: ${typeof result}`, 'blue');
      log(`Result keys: ${Object.keys(result).join(', ')}`, 'blue');
    } catch (error) {
      log(`✗ Test 2 FAILED: ${error.message}`, 'red');
      log(`Error type: ${error.constructor.name}`, 'red');
    }
    log('');

    // Get cache stats
    log('=== Cache Statistics ===', 'magenta');
    const stats = await cache.getStats();
    log(`Cached entries: ${stats.cached}`, 'blue');
    log(`Hits: ${stats.hits}`, 'blue');
    log(`Misses: ${stats.misses}`, 'blue');
    log(`Hit rate: ${stats.hitRate.toFixed(2)}%`, 'blue');
    log(`Saved calls: ${stats.savedCalls}`, 'blue');
    log('');

    if (stats.byTool) {
      log('By tool:', 'blue');
      for (const [tool, toolStats] of Object.entries(stats.byTool)) {
        log(`  ${tool}:`, 'blue');
        log(`    Hits: ${toolStats.hits}`, 'blue');
        log(`    Misses: ${toolStats.misses}`, 'blue');
        log(`    Hit rate: ${toolStats.hitRate.toFixed(2)}%`, 'blue');
      }
    }
    log('');

    // Cleanup
    log('Cleaning up...', 'yellow');
    await upstreamManager.closeAll();
    log('Cleanup complete', 'green');

    log('=== Test Summary ===', 'magenta');
    log('Check the stderr output above for [FAILOVER] log messages', 'yellow');
    log('Look for messages indicating failover from web-search-prime to searxng', 'yellow');

  } catch (error) {
    log(`Fatal error: ${error.message}`, 'red');
    log(error.stack, 'red');
    process.exit(1);
  }
}

testFailover();
