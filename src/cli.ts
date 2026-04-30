import type { CacheStore } from './cache.js';
import { readFile } from 'fs/promises';
import path from 'path';

export interface CliArgs {
  mode: 'server' | 'stats' | 'flush' | 'new' | 'help';
  tool?: string;
  configPath?: string;
}

export interface CliResult {
  output: string;
  exitCode: number;
}

const HELP_TEXT = `MCP Cache Proxy CLI

Usage: mcp-cache-proxy [options]

Options:
  --stats              Display cache statistics
  --flush [tool]       Flush cache for specific tool or all caches
  --new                Recreate cache database
  --config <path>      Path to configuration file
  --help               Display this help message

Examples:
  mcp-cache-proxy --stats
  mcp-cache-proxy --flush
  mcp-cache-proxy --flush search-prime
  mcp-cache-proxy --new
  mcp-cache-proxy --config /path/to/config.json
`;

export interface ParseResult {
  args: CliArgs;
  errors: string[];
  warnings: string[];
}

export function parseCliArgs(args: string[]): ParseResult {
  const result: CliArgs = { mode: 'server' };
  const errors: string[] = [];
  const warnings: string[] = [];
  const modeFlags = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--stats':
        modeFlags.add('stats');
        result.mode = 'stats';
        break;
      case '--flush':
        modeFlags.add('flush');
        result.mode = 'flush';
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          result.tool = args[++i];
        }
        break;
      case '--new':
        modeFlags.add('new');
        result.mode = 'new';
        break;
      case '--config':
        if (i + 1 < args.length) {
          result.configPath = args[++i];
        }
        break;
      case '--help':
        result.mode = 'help';
        break;
      default:
        if (arg.startsWith('--')) {
          warnings.push(`Unknown flag: ${arg}`);
        } else if (result.mode === 'flush' && !result.tool) {
          result.tool = arg;
        } else {
          warnings.push(`Unexpected argument: ${arg}`);
        }
    }
  }

  // Check for conflicting mode flags
  if (modeFlags.size > 1) {
    const flags = Array.from(modeFlags).join(', ');
    errors.push(`Conflicting flags: ${flags}. Only one mode flag (--stats, --flush, --new) can be used at a time.`);
  }

  return { args: result, errors, warnings };
}

export async function handleCliCommand(args: CliArgs, cache: CacheStore): Promise<CliResult> {
  try {
    switch (args.mode) {
      case 'help': {
        return {
          output: HELP_TEXT,
          exitCode: 0
        };
      }
      case 'stats': {
        const stats = await cache.getStats();
        return {
          output: JSON.stringify(stats, null, 2),
          exitCode: 0
        };
      }
      case 'flush': {
        await cache.flush(args.tool);
        return {
          output: args.tool ? `Flushed cache for: ${args.tool}` : 'Flushed all cache',
          exitCode: 0
        };
      }
      case 'new': {
        await cache.recreate();
        return {
          output: 'Cache database recreated',
          exitCode: 0
        };
      }
      default:
        return {
          output: '',
          exitCode: 0
        };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      output: `Error: ${errorMessage}`,
      exitCode: 1
    };
  }
}

export async function validateConfigPath(configPath: string | undefined): Promise<string[]> {
  const errors: string[] = [];

  if (configPath) {
    try {
      // Check if the path exists
      const absolutePath = path.resolve(configPath);
      await readFile(absolutePath, 'utf-8');
    } catch (error) {
      errors.push(`Invalid config path: ${configPath} - ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return errors;
}
