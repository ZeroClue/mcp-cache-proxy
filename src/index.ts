#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, type ServerConfig } from './config.js';
import { CacheStore } from './cache.js';
import { ToolRouter } from './proxy.js';
import { parseCliArgs, handleCliCommand } from './cli.js';

async function main() {
  const { args, errors, warnings } = parseCliArgs(process.argv.slice(2));

  // Report any warnings
  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }

  // Report any errors and exit
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`Error: ${error}`);
    }
    process.exit(1);
  }

  const configPath = args.configPath
    ? new URL(`file://${args.configPath}`)
    : new URL(`file://${process.env.HOME}/.mcp-cache-proxy/config.json`);

  const config = await loadConfig(configPath);
  const cache = new CacheStore(config.cache);

  if (args.mode !== 'server') {
    const result = await handleCliCommand(args, cache);
    console.log(result.output);
    process.exit(result.exitCode);
  }

  // MCP Server Mode
  const server = new Server(
    { name: 'mcp-cache-proxy', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  const router = new ToolRouter(cache, config.servers, config.mode);

  // Register cache management tools
  router.registerTool({
    name: 'cache_stats',
    description: 'Get cache statistics',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  });

  router.registerTool({
    name: 'cache_flush',
    description: 'Flush cache entries',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Optional tool name to flush' }
      }
    }
  });

  router.registerTool({
    name: 'cache_new',
    description: 'Recreate the cache database',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  });

  // Register upstream tools (simplified - would connect to actual servers)
  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    const toolPrefix = serverName.replace(/-/g, '_');
    router.registerTool({
      name: `${toolPrefix}_search`,
      description: `Search via ${serverName}`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        },
        required: ['query']
      }
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: router.getTools()
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Handle cache management tools
    if (name === 'cache_stats') {
      const stats = await cache.getStats();
      return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
    }

    if (name === 'cache_flush') {
      await cache.flush((args as { tool?: string })?.tool);
      return { content: [{ type: 'text', text: 'Cache flushed' }] };
    }

    if (name === 'cache_new') {
      await cache.recreate();
      return { content: [{ type: 'text', text: 'Cache recreated' }] };
    }

    // Handle upstream tools (simplified - no actual upstream connection)
    return await router.callTool(name, args, async () => {
      // TODO: Connect to actual upstream MCP server
      return { content: [{ type: 'text', text: 'Upstream not implemented' }] };
    }) as { content: Array<{ type: string; text: string }> };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
