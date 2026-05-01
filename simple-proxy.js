#!/usr/bin/env node

// Simple test: Start the proxy as a server and list tools
import { loadConfigWithProjectLookup } from './dist/config.js';
import { CacheStore } from './dist/cache.js';
import { ToolRouter } from './dist/cache.js';
import { UpstreamManager } from './dist/upstream.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const config = await loadConfigWithProjectLookup();
const cache = new CacheStore(config.cache);
const upstream = new UpstreamManager();
const router = new ToolRouter(cache, config.servers, config.mode);

// Connect to all servers
for (const [serverName, serverConfig] of Object.entries(config.servers)) {
  try {
    await upstream.connect(serverName, serverConfig);
    const tools = await upstream.listTools(serverName);
    for (const tool of tools) {
      router.registerTool(tool);
    }
  } catch (err) {
    console.error(`Failed to connect to ${serverName}:`, err);
  }
}

// Create server
const server = new Server(
  { name: 'mcp-cache-proxy', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: router.getTools()
}));

const transport = new StdioServerTransport();
await server.connect(transport);

console.log('Proxy running. Press Ctrl+C to exit.');
