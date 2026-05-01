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
  private inflightRefreshes: Set<string>;

  constructor(cache: CacheStore, servers: Record<string, ServerConfig>, mode: 'whitelist' | 'blacklist', defaultNegativeCacheTtlSeconds: number = 300) {
    this.cache = cache;
    this.servers = servers;
    this.mode = mode;
    this.defaultNegativeCacheTtlSeconds = defaultNegativeCacheTtlSeconds;
    this.tools = new Map();
    this.toolToServer = new Map();
    this.inflightRefreshes = new Set();
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

  getToolToServerMap(): Map<string, string> {
    return new Map(this.toolToServer);
  }

  private resolveTtl(toolName: string, serverName: string | null): number {
    if (serverName && (this.servers[serverName] as { adaptiveTtl?: boolean }).adaptiveTtl) {
      const adaptiveTtl = this.cache.getAdaptiveTtl(toolName);
      if (adaptiveTtl !== null) return adaptiveTtl;
    }
    return serverName ? (this.servers[serverName].cacheTtlSeconds || 43200) : 43200;
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

    // Check cache first (separate from upstream error handling)
    const cached = await this.cache.getWithStale(key, toolName);

    if (cached !== null) {
      // Cached errors (fresh or stale) — re-throw without re-caching
      if (cached.value instanceof Error) throw cached.value;
      if (cached.stale) {
        const serverName = this.findServerForTool(toolName);
        const ttl = this.resolveTtl(toolName, serverName);
        this.refreshInBackground(key, toolName, args, upstream, ttl).catch(() => {});
      }
      return cached.value;
    }

    // Cache miss — call upstream and cache the result
    try {
      const result = await upstream();

      const serverName = this.findServerForTool(toolName);
      if (serverName) {
        const ttl = this.resolveTtl(toolName, serverName);
        await this.cache.set(key, toolName, args, result, ttl);
      }

      return result;
    } catch (error) {
      // Only cache errors from upstream (not from cache hits above)
      const serverName = this.findServerForTool(toolName);
      if (serverName) {
        const negativeTtl = this.servers[serverName].negativeCacheTtlSeconds || this.defaultNegativeCacheTtlSeconds;
        await this.cache.set(key, toolName, args, error, negativeTtl, true);
      }
      throw error;
    }
  }

  private refreshInBackground(key: string, toolName: string, args: unknown, upstream: UpstreamCall, ttl: number): Promise<void> {
    if (this.inflightRefreshes.has(key)) return Promise.resolve();
    this.inflightRefreshes.add(key);
    return upstream().then(result => {
      return this.cache.touch(key, toolName, args, result, ttl);
    }).catch(err => {
      console.error(`[CACHE] Background refresh failed for ${toolName}:`, err);
    }).finally(() => {
      this.inflightRefreshes.delete(key);
    });
  }
}
