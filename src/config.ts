import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cwd } from 'node:process';

export interface ServerConfig {
  command?: string;  // For stdio servers
  args?: string[];   // For stdio servers
  url?: string;      // For HTTP servers
  env?: Record<string, string>;
  cacheTtlSeconds?: number;
}

export interface CacheConfig {
  path: string;
  maxSizeBytes: number;
  defaultTtlSeconds: number;
}

export interface Config {
  servers: Record<string, ServerConfig>;
  cache: CacheConfig;
  mode: 'whitelist' | 'blacklist';
  extendGlobal?: boolean;
}

const DEFAULT_CACHE_CONFIG: CacheConfig = {
  path: join(homedir(), '.mcp-cache-proxy/cache.db'),
  maxSizeBytes: 104857600,
  defaultTtlSeconds: 43200
};

const GLOBAL_CONFIG_PATH = join(homedir(), '.mcp-cache-proxy/config.json');
const PROJECT_CONFIG_FILENAME = '.mcp-cache-proxy.json';

async function loadConfig(configPath: URL | string): Promise<Config> {
  const content = await fs.readFile(configPath, 'utf-8');
  const config = JSON.parse(content) as Partial<Config>;

  if (!config.servers || typeof config.servers !== 'object') {
    throw new Error('Config validation failed: missing or invalid "servers"');
  }

  return {
    servers: config.servers as Record<string, ServerConfig>,
    cache: { ...DEFAULT_CACHE_CONFIG, ...config.cache },
    mode: config.mode || 'whitelist',
    extendGlobal: config.extendGlobal !== false
  };
}

/**
 * Deep merge two configs with specific rules:
 * - Arrays are replaced (not merged)
 * - Objects are deep merged
 * - Primitive values override
 */
function mergeConfigs(base: Config, override: Partial<Config>): Config {
  const merged: Config = {
    servers: { ...base.servers },
    cache: { ...base.cache },
    mode: override.mode ?? base.mode,
    extendGlobal: override.extendGlobal ?? base.extendGlobal
  };

  // Merge servers - replace entire server objects, don't merge fields
  if (override.servers) {
    for (const [serverName, serverConfig] of Object.entries(override.servers)) {
      if (base.servers[serverName]) {
        console.warn(`Warning: Project config overrides global server definition: ${serverName}`);
      }
      merged.servers[serverName] = serverConfig;
    }
  }

  // Merge cache config - replace arrays/primitives, not deep merge
  if (override.cache) {
    merged.cache = { ...base.cache, ...override.cache };
  }

  return merged;
}

/**
 * Load config with project-specific lookup and merging.
 *
 * Lookup order:
 * 1. Explicit configPath parameter (from --config or env var)
 * 2. .mcp-cache-proxy.json in current working directory
 * 3. ~/.mcp-cache-proxy/config.json (global default)
 *
 * When project config has extendGlobal: true (default), it merges with global config.
 * When extendGlobal: false, project config is used standalone.
 */
async function loadConfigWithProjectLookup(configPath?: string): Promise<Config> {
  // Case 1: Explicit config path provided
  if (configPath) {
    return await loadConfig(configPath);
  }

  // Case 2: Check for project config in current directory
  const projectConfigPath = join(cwd(), PROJECT_CONFIG_FILENAME);
  let projectConfigExists = false;

  try {
    await fs.access(projectConfigPath);
    projectConfigExists = true;
  } catch {
    // Project config doesn't exist
  }

  if (projectConfigExists) {
    const projectConfig = await loadConfig(projectConfigPath);

    // Check if project config wants to extend global config
    if (projectConfig.extendGlobal !== false) {
      // Load and merge with global config
      try {
        const globalConfig = await loadConfig(GLOBAL_CONFIG_PATH);
        return mergeConfigs(globalConfig, projectConfig);
      } catch (error) {
        throw new Error(
          `Project config has extendGlobal: true but global config failed to load: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // extendGlobal: false - use project config standalone
    return projectConfig;
  }

  // Case 3: No project config, load global config
  try {
    return await loadConfig(GLOBAL_CONFIG_PATH);
  } catch (error) {
    throw new Error(
      `Failed to load global config from ${GLOBAL_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export { loadConfig, loadConfigWithProjectLookup, mergeConfigs };
