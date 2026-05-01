#!/usr/bin/env node

import { loadConfigWithProjectLookup } from './dist/config.js';
import { CacheStore } from './dist/cache.js';
import { ToolRouter } from './dist/proxy.js';
import { UpstreamManager } from './dist/upstream.js';

async function listVisibleTools() {
  console.log('🔍 Tools Visible to Claude Code\n');
  console.log('(What Claude sees when connecting to the proxy)\n');

  const config = await loadConfigWithProjectLookup();
  const cache = new CacheStore(config.cache);
  const upstream = new UpstreamManager();
  const router = new ToolRouter(cache, config.servers, config.mode);

  // Connect to all servers and register their tools
  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    try {
      await upstream.connect(serverName, serverConfig);
      const tools = await upstream.listTools(serverName);

      console.log(`\n📦 From ${serverName}:`);
      tools.forEach(tool => {
        router.registerTool(tool);
        console.log(`   - ${tool.name}`);
        if (tool.description) {
          console.log(`     ${tool.description.slice(0, 80)}...`);
        }
      });
    } catch (error) {
      console.error(`\n❌ ${serverName}: ${error.message}`);
    }
  }

  const allTools = router.getTools();

  console.log(`\n\n✨ Total tools visible: ${allTools.length}\n`);

  console.log('📋 Complete tool list:\n');
  allTools.forEach(tool => {
    console.log(`   ${tool.name}`);
  });

  upstream.close();
}

listVisibleTools().catch(console.error);
