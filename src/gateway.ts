import type { UpstreamManager } from './upstream.js';
import type { ToolRouter } from './proxy.js';
import type { OnDemandServerConfig } from './config.js';

const DEFAULT_IDLE_TIMEOUT = 1800; // 30 minutes

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
}

interface LoadedServer {
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout>;
  toolCount: number;
}

interface ServerStatus {
  loaded: boolean;
  idleSeconds: number;
  toolCount: number;
}

export class GatewayManager {
  private upstream: UpstreamManager;
  private router: ToolRouter;
  private onDemandConfig: Record<string, OnDemandServerConfig>;
  private loadedServers: Map<string, LoadedServer> = new Map();
  private toolSchemas: Map<string, Map<string, ToolDefinition>> = new Map();
  private activeRequests: Map<string, number> = new Map();
  private loadingServers: Map<string, Promise<void>> = new Map();

  constructor(
    upstream: UpstreamManager,
    router: ToolRouter,
    onDemandConfig: Record<string, OnDemandServerConfig>
  ) {
    this.upstream = upstream;
    this.router = router;
    this.onDemandConfig = onDemandConfig;
  }

  /**
   * Generate meta-tool definitions for all on-demand servers.
   * Each on-demand server gets a single meta-tool named `<serverName>_call`.
   */
  getMetaTools(): ToolDefinition[] {
    const metaTools: ToolDefinition[] = [];

    for (const [serverName, config] of Object.entries(this.onDemandConfig)) {
      const safeName = serverName.replace(/-/g, '_');
      metaTools.push({
        name: `${safeName}_call`,
        description: `Execute tools from the ${serverName} server (lazy-loaded on first call). Use describe_tool('${serverName}', '<tool_name>') to get parameter details for a specific tool.`,
        inputSchema: {
          type: 'object',
          properties: {
            tool_name: {
              type: 'string',
              description: `Name of the ${serverName} tool to execute`
            },
            arguments: {
              type: 'object',
              description: 'Arguments to pass to the tool'
            }
          },
          required: ['tool_name']
        }
      });
    }

    return metaTools;
  }

  /**
   * Get the on-demand server name from a meta-tool name.
   * e.g., "n8n_mcp_call" → "n8n-mcp"
   */
  getServerForMetaTool(metaToolName: string): string | null {
    for (const serverName of Object.keys(this.onDemandConfig)) {
      const safeName = serverName.replace(/-/g, '_');
      if (metaToolName === `${safeName}_call`) {
        return serverName;
      }
    }
    return null;
  }

  /**
   * Check if a tool name is one of our meta-tools.
   */
  isMetaTool(toolName: string): boolean {
    return this.getServerForMetaTool(toolName) !== null;
  }

  /**
   * Lazy-load an on-demand server, then route a tool call to it.
   */
  async routeCall(serverName: string, toolName: string, args: unknown): Promise<unknown> {
    // Track active request
    this.activeRequests.set(serverName, (this.activeRequests.get(serverName) || 0) + 1);

    try {
      await this.ensureLoaded(serverName);

      // Validate tool exists on this server
      const schemas = this.toolSchemas.get(serverName);
      if (schemas && !schemas.has(toolName)) {
        const available = Array.from(schemas.keys()).join(', ');
        return {
          content: [{ type: 'text', text: `Unknown tool "${toolName}" on ${serverName}. Available tools: ${available}` }],
          isError: true
        };
      }

      // Reset idle timer on use
      this.resetIdleTimer(serverName);

      // Route through the normal proxy pipeline (handles caching)
      return await this.upstream.callTool(serverName, toolName, args);
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error calling ${toolName} on ${serverName}: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    } finally {
      const count = (this.activeRequests.get(serverName) || 1) - 1;
      if (count <= 0) {
        this.activeRequests.delete(serverName);
      } else {
        this.activeRequests.set(serverName, count);
      }
    }
  }

  /**
   * Return the full schema for a sub-tool. Discovers tools if server not yet loaded.
   */
  async describeTool(serverName: string, toolName: string): Promise<ToolDefinition | null> {
    const config = this.onDemandConfig[serverName];
    if (!config) return null;

    await this.ensureLoaded(serverName);

    const schemas = this.toolSchemas.get(serverName);
    if (!schemas) return null;

    return schemas.get(toolName) || null;
  }

  /**
   * Get status of all on-demand servers.
   */
  getStatus(): Record<string, ServerStatus> {
    const status: Record<string, ServerStatus> = {};

    for (const serverName of Object.keys(this.onDemandConfig)) {
      const loaded = this.loadedServers.get(serverName);
      status[serverName] = {
        loaded: !!loaded,
        idleSeconds: loaded ? Math.floor((Date.now() - loaded.lastUsed) / 1000) : 0,
        toolCount: loaded?.toolCount || 0
      };
    }

    return status;
  }

  /**
   * Force-unload a server immediately. Refuses if there are active requests.
   */
  async unloadServer(serverName: string): Promise<{ success: boolean; message: string }> {
    if (!this.loadedServers.has(serverName)) {
      return { success: false, message: `Server ${serverName} is not loaded` };
    }

    const active = this.activeRequests.get(serverName) || 0;
    if (active > 0) {
      return { success: false, message: `Cannot unload ${serverName}: ${active} request(s) in progress` };
    }

    this.doUnload(serverName);
    return { success: true, message: `Unloaded ${serverName}` };
  }

  /**
   * Ensure a server is loaded. If already loaded, just reset the timer.
   */
  private async ensureLoaded(serverName: string): Promise<void> {
    if (this.loadedServers.has(serverName)) {
      return; // Already loaded
    }

    // If another call is already loading this server, wait for it
    const inFlight = this.loadingServers.get(serverName);
    if (inFlight) {
      await inFlight;
      return;
    }

    const config = this.onDemandConfig[serverName];
    if (!config) {
      throw new Error(`Unknown on-demand server: ${serverName}`);
    }

    // Create the loading promise and register it before starting
    const loadPromise = this.doLoad(serverName, config);
    this.loadingServers.set(serverName, loadPromise);

    try {
      await loadPromise;
    } finally {
      this.loadingServers.delete(serverName);
    }
  }

  private async doLoad(serverName: string, config: OnDemandServerConfig): Promise<void> {
    console.error(`[GATEWAY] Loading on-demand server: ${serverName}`);

    // Connect to the upstream server
    await this.upstream.connect(serverName, config);

    // Discover tools
    const tools = await this.upstream.listTools(serverName);

    // Cache schemas
    const schemaMap = new Map<string, ToolDefinition>();
    for (const tool of tools) {
      schemaMap.set(tool.name, tool);
    }
    this.toolSchemas.set(serverName, schemaMap);

    // Register tools in the router (for caching/routing)
    for (const tool of tools) {
      this.router.registerTool(tool, serverName);
    }

    // Start idle timer
    const idleTimeout = config.idleTimeoutSeconds || DEFAULT_IDLE_TIMEOUT;
    const timer = setTimeout(() => this.autoUnload(serverName), idleTimeout * 1000);

    this.loadedServers.set(serverName, {
      lastUsed: Date.now(),
      idleTimer: timer,
      toolCount: tools.length
    });

    console.error(`[GATEWAY] Loaded ${serverName} with ${tools.length} tools (idle timeout: ${idleTimeout}s)`);
  }

  private resetIdleTimer(serverName: string): void {
    const loaded = this.loadedServers.get(serverName);
    if (!loaded) return;

    clearTimeout(loaded.idleTimer);

    const config = this.onDemandConfig[serverName];
    const idleTimeout = config?.idleTimeoutSeconds || DEFAULT_IDLE_TIMEOUT;
    loaded.idleTimer = setTimeout(() => this.autoUnload(serverName), idleTimeout * 1000);
    loaded.lastUsed = Date.now();
  }

  private autoUnload(serverName: string): void {
    const active = this.activeRequests.get(serverName) || 0;
    if (active > 0) {
      console.error(`[GATEWAY] Skipping auto-unload of ${serverName}: ${active} request(s) in progress`);
      this.resetIdleTimer(serverName);
      return;
    }

    console.error(`[GATEWAY] Auto-unloading idle server: ${serverName}`);
    this.doUnload(serverName);
  }

  private doUnload(serverName: string): void {
    const loaded = this.loadedServers.get(serverName);
    if (loaded) {
      clearTimeout(loaded.idleTimer);
      this.loadedServers.delete(serverName);
    }

    this.toolSchemas.delete(serverName);
    this.activeRequests.delete(serverName);
    this.router.unregisterToolsForServer(serverName);
    this.upstream.disconnectServer(serverName);
  }

  /**
   * Clean up all loaded servers on shutdown.
   */
  close(): void {
    for (const [name, loaded] of this.loadedServers.entries()) {
      clearTimeout(loaded.idleTimer);
      this.router.unregisterToolsForServer(name);
      this.upstream.disconnectServer(name);
    }
    this.loadedServers.clear();
    this.toolSchemas.clear();
    this.activeRequests.clear();
    this.loadingServers.clear();
  }
}
