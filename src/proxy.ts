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

  constructor(cache: CacheStore, servers: Record<string, ServerConfig>, mode: 'whitelist' | 'blacklist') {
    this.cache = cache;
    this.servers = servers;
    this.mode = mode;
    this.tools = new Map();
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  getTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  findServerForTool(toolName: string): string | null {
    for (const [serverName, config] of Object.entries(this.servers)) {
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
    if (!this.isCacheable(toolName)) {
      return upstream();
    }

    const key = generateKey(toolName, args);
    const cached = await this.cache.get(key);

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
  }
}
