import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ServerConfig {
  command: string;
  args: string[];
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

export { loadConfig };
