import { generateKey } from './keygen.js';
import type { CacheStore } from './cache.js';
import type { ServerConfig } from './config.js';

interface UpstreamCall {
  (): Promise<unknown>;
}

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export class ToolRouter {
  private cache: CacheStore;
  private servers: Record<string, ServerConfig>;
  private mode: 'whitelist' | 'blacklist';
  private tools: Map<string, ToolDefinition>;
  private toolToServer: Map<string, string>;
  private defaultNegativeCacheTtlSeconds: number;

  constructor(cache: CacheStore, servers: Record<string, ServerConfig>, mode: 'whitelist' | 'blacklist', defaultNegativeCacheTtlSeconds: number = 300) {
    this.cache = cache;
    this.servers = servers;
    this.mode = mode;
    this.defaultNegativeCacheTtlSeconds = defaultNegativeCacheTtlSeconds;
    this.tools = new Map();
    this.toolToServer = new Map();
  }

  registerTool(tool: ToolDefinition, serverName?: string): void {
    this.tools.set(tool.name, tool);
    if (serverName) {
      this.toolToServer.set(tool.name, serverName);
    }
  }

  getTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  findServerForTool(toolName: string): string | null {
    // Exact match from registration (most reliable)
    const registered = this.toolToServer.get(toolName);
    if (registered) return registered;

    // Fallback: prefix match for cache management tools
    for (const serverName of Object.keys(this.servers)) {
      if (toolName.startsWith(serverName.replace(/-/g, '_'))) {
        return serverName;
      }
    }
    return null;
  }

  isCacheable(toolName: string): boolean {
    const blacklist = ['browser_click', 'browser_type', 'browser_fill_form', 'Edit', 'Write', 'Bash'];
    
    if (this.mode === 'blacklist') {
      return !blacklist.includes(toolName);
    }
    
    const toolServer = this.findServerForTool(toolName);
    return toolServer !== null;
  }

  async callTool(toolName: string, args: unknown, upstream: UpstreamCall): Promise<unknown> {
    const cacheable = this.isCacheable(toolName);
    const server = this.findServerForTool(toolName);
    console.error(`[CACHE] tool=${toolName} cacheable=${cacheable} server=${server}`);
    if (!cacheable) {
      return upstream();
    }

    const key = generateKey(toolName, args);

    try {
      const cached = await this.cache.get(key, toolName);

      if (cached !== null) {
        return cached;
      }

      const result = await upstream();

      const serverName = this.findServerForTool(toolName);
      if (serverName) {
        const ttl = this.servers[serverName].cacheTtlSeconds || 43200;
        await this.cache.set(key, toolName, args, result, ttl);
      }

      return result;
    } catch (error) {
      // Cache errors with negative cache TTL (per-server or default)
      const serverName = this.findServerForTool(toolName);
      if (serverName) {
        const negativeTtl = this.servers[serverName].negativeCacheTtlSeconds || this.defaultNegativeCacheTtlSeconds;
        await this.cache.set(key, toolName, args, error, negativeTtl, true);
      }
      throw error;
    }
  }
}
