#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfigWithProjectLookup } from './config.js';
import { CacheStore } from './cache.js';
import { ToolRouter } from './proxy.js';
import { UpstreamManager } from './upstream.js';
import { GatewayManager } from './gateway.js';
import { parseCliArgs, handleCliCommand } from './cli.js';

async function main() {
  const { args, errors, warnings } = parseCliArgs(process.argv.slice(2));

  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`Error: ${error}`);
    }
    process.exit(1);
  }

  let configPath = args.configPath || process.env.MCP_CACHE_CONFIG;
  if (configPath?.startsWith('~/')) {
    configPath = join(homedir(), configPath.slice(2));
  }
  const config = await loadConfigWithProjectLookup(configPath);
  const cache = new CacheStore(config.cache);

  // Handle CLI modes that don't need upstream/router
  if (['help', 'stats', 'flush', 'new', 'export', 'import', 'tune-ttl'].includes(args.mode)) {
    const result = await handleCliCommand(args, cache);
    console.log(result.output);
    process.exit(result.exitCode);
  }

  // Handle warm mode - needs upstream and router
  if (args.mode === 'warm') {
    const upstream = new UpstreamManager();

    // Connect to all upstream servers
    for (const [serverName, serverConfig] of Object.entries(config.servers)) {
      try {
        await upstream.connect(serverName, serverConfig);
      } catch (err) {
        console.error(`Failed to connect to ${serverName}:`, err);
      }
    }

    const router = new ToolRouter(cache, config.servers, config.mode, config.cache.negativeCacheTtlSeconds);

    // Register upstream tools
    for (const [serverName] of Object.entries(config.servers)) {
      try {
        const tools = await upstream.listTools(serverName);
        for (const tool of tools) {
          router.registerTool(tool, serverName);
        }
      } catch (err) {
        console.error(`Failed to list tools for ${serverName}:`, err);
      }
    }

    const result = await handleCliCommand(args, cache, upstream, router);
    console.log(result.output);
    upstream.close();
    process.exit(result.exitCode);
  }

  // Server mode
  const upstream = new UpstreamManager();

  // Connect to all upstream servers
  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    try {
      await upstream.connect(serverName, serverConfig);
    } catch (err) {
      console.error(`Failed to connect to ${serverName}:`, err);
    }
  }

  const server = new Server(
    { name: 'mcp-cache-proxy', version: '0.3.1' },
    { capabilities: { tools: {} } }
  );

  const router = new ToolRouter(cache, config.servers, config.mode, config.cache.negativeCacheTtlSeconds);

  // Register cache management tools
  router.registerTool({
    name: 'cache_stats',
    description: 'Get cache and proxy statistics including per-tool breakdown and upstream server metrics',
    inputSchema: { type: 'object', properties: {} }
  });

  router.registerTool({
    name: 'cache_flush',
    description: 'Flush cache entries',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string' }
      }
    }
  });

  router.registerTool({
    name: 'cache_new',
    description: 'Recreate the cache database',
    inputSchema: { type: 'object', properties: {} }
  });

  // Register upstream tools
  for (const [serverName] of Object.entries(config.servers)) {
    try {
      const tools = await upstream.listTools(serverName);
      for (const tool of tools) {
        router.registerTool(tool, serverName);
      }
    } catch (err) {
      console.error(`Failed to list tools for ${serverName}:`, err);
    }
  }

  // Set up gateway for on-demand servers
  let gateway: GatewayManager | undefined;
  if (config.onDemandServers && Object.keys(config.onDemandServers).length > 0) {
    gateway = new GatewayManager(upstream, router, config.onDemandServers);

    // Register meta-tools for on-demand servers
    for (const metaTool of gateway.getMetaTools()) {
      router.registerTool(metaTool);
    }

    // Register gateway management tools
    router.registerTool({
      name: 'gateway_status',
      description: 'Get status of all on-demand (lazy-loaded) servers: loaded/unloaded, idle time, tool counts',
      inputSchema: { type: 'object', properties: {} }
    });

    router.registerTool({
      name: 'gateway_unload',
      description: 'Force-unload an on-demand server immediately (refuses if requests are in-flight)',
      inputSchema: {
        type: 'object',
        properties: {
          server_name: { type: 'string', description: 'Name of the on-demand server to unload' }
        },
        required: ['server_name']
      }
    });

    router.registerTool({
      name: 'describe_tool',
      description: 'Get the full input schema for a sub-tool on an on-demand server. Discovers tools if server not yet loaded.',
      inputSchema: {
        type: 'object',
        properties: {
          server_name: { type: 'string', description: 'Name of the on-demand server' },
          tool_name: { type: 'string', description: 'Name of the sub-tool' }
        },
        required: ['server_name', 'tool_name']
      }
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: router.getTools()
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Handle cache management tools
      if (name === 'cache_stats') {
        const cacheStats = await cache.getStats();
        const proxyStats = upstream.getProxyStats();
        const gatewayStatus = gateway?.getStatus();
        return { content: [{ type: 'text', text: JSON.stringify({ ...cacheStats, proxyStats, gateway: gatewayStatus }, null, 2) }] };
      }

      if (name === 'cache_flush') {
        await cache.flush((args as { tool?: string })?.tool);
        return { content: [{ type: 'text', text: 'Cache flushed' }] };
      }

      if (name === 'cache_new') {
        await cache.recreate();
        return { content: [{ type: 'text', text: 'Cache recreated' }] };
      }

      // Handle gateway management tools
      if (name === 'gateway_status' && gateway) {
        return { content: [{ type: 'text', text: JSON.stringify(gateway.getStatus(), null, 2) }] };
      }

      if (name === 'gateway_unload' && gateway) {
        const { server_name } = args as { server_name: string };
        const result = await gateway.unloadServer(server_name);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'describe_tool' && gateway) {
        const { server_name, tool_name } = args as { server_name: string; tool_name: string };
        const schema = await gateway.describeTool(server_name, tool_name);
        if (!schema) {
          return { content: [{ type: 'text', text: `Tool "${tool_name}" not found on ${server_name}` }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }] };
      }

      // Handle meta-tool calls (on-demand servers)
      if (gateway?.isMetaTool(name)) {
        const serverName = gateway.getServerForMetaTool(name)!;
        const metaArgs = args as { tool_name: string; arguments?: unknown };
        return await gateway.routeCall(serverName, metaArgs.tool_name, metaArgs.arguments) as { content: unknown };
      }

      // Route to upstream
      const serverName = router.findServerForTool(name);
      if (serverName) {
        return await router.callTool(name, args, async () => {
          return await upstream.callTool(serverName, name, args);
        }) as { content: unknown };
      }

      throw new Error(`Tool not found: ${name}`);
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start adaptive TTL background adaptor if any server has adaptiveTtl enabled
  const hasAdaptiveTtl = Object.values(config.servers).some(s => s.adaptiveTtl);
  let adaptorInterval: ReturnType<typeof setInterval> | undefined;
  if (hasAdaptiveTtl) {
    cache.initAdaptiveTtls(config.servers, router.getToolToServerMap());
    adaptorInterval = setInterval(async () => {
      try {
        // Re-read tool mapping each cycle to pick up dynamic tool registrations
        await cache.adaptTtls(config.servers, router.getToolToServerMap());
      } catch (err) {
        console.error('[ADAPTIVE-TTL] Background adaptor error:', err);
      }
    }, 10 * 60 * 1000);
  }

  process.on('SIGINT', () => {
    if (adaptorInterval) clearInterval(adaptorInterval);
    gateway?.close();
    upstream.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
