import type { CacheStore } from './cache.js';
import type { UpstreamManager } from './upstream.js';
import type { ToolRouter } from './proxy.js';
import { readFile } from 'fs/promises';
import path from 'path';

export interface CliArgs {
  mode: 'server' | 'stats' | 'flush' | 'new' | 'help' | 'warm' | 'export' | 'import' | 'tune-ttl';
  tool?: string;
  configPath?: string;
  queriesPath?: string;
  exportPath?: string;
  importPath?: string;
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
  --warm --queries <file>  Warm cache with queries from file
  --export <file>      Export cache to JSON file
  --import <file>      Import cache from JSON file
  --tune-ttl           Show adaptive TTL status and eviction statistics
  --config <path>      Path to configuration file
  --help               Display this help message

Examples:
  mcp-cache-proxy --stats
  mcp-cache-proxy --flush
  mcp-cache-proxy --flush search-prime
  mcp-cache-proxy --new
  mcp-cache-proxy --warm --queries queries.txt
  mcp-cache-proxy --export cache-backup.json
  mcp-cache-proxy --import cache-backup.json
  mcp-cache-proxy --tune-ttl
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
      case '--warm':
        modeFlags.add('warm');
        result.mode = 'warm';
        break;
      case '--queries':
        if (i + 1 < args.length) {
          result.queriesPath = args[++i];
        }
        break;
      case '--export':
        modeFlags.add('export');
        result.mode = 'export';
        if (i + 1 < args.length) {
          result.exportPath = args[++i];
        }
        break;
      case '--import':
        modeFlags.add('import');
        result.mode = 'import';
        if (i + 1 < args.length) {
          result.importPath = args[++i];
        }
        break;
      case '--tune-ttl':
        modeFlags.add('tune-ttl');
        result.mode = 'tune-ttl';
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
    errors.push(`Conflicting flags: ${flags}. Only one mode flag (--stats, --flush, --new, --warm, --export, --import, --tune-ttl) can be used at a time.`);
  }

  // Validate warm mode has queries file
  if (result.mode === 'warm' && !result.queriesPath) {
    errors.push('--warm requires --queries <file>');
  }

  // Validate export mode has file path
  if (result.mode === 'export' && !result.exportPath) {
    errors.push('--export requires a file path');
  }

  // Validate import mode has file path
  if (result.mode === 'import' && !result.importPath) {
    errors.push('--import requires a file path');
  }

  return { args: result, errors, warnings };
}

export async function handleCliCommand(
  args: CliArgs,
  cache: CacheStore,
  upstream?: UpstreamManager,
  router?: ToolRouter
): Promise<CliResult> {
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
      case 'warm': {
        if (!args.queriesPath) {
          return {
            output: 'Error: --queries file path is required for --warm mode',
            exitCode: 1
          };
        }
        if (!upstream || !router) {
          return {
            output: 'Error: Warm mode requires upstream and router (internal error)',
            exitCode: 1
          };
        }
        return await warmCache(args.queriesPath, cache, upstream, router);
      }
      case 'export': {
        if (!args.exportPath) {
          return {
            output: 'Error: --export requires a file path',
            exitCode: 1
          };
        }
        await cache.exportCache(args.exportPath);
        return {
          output: `Cache exported to: ${args.exportPath}`,
          exitCode: 0
        };
      }
      case 'import': {
        if (!args.importPath) {
          return {
            output: 'Error: --import requires a file path',
            exitCode: 1
          };
        }
        const result = await cache.importCache(args.importPath);
        return {
          output: `Cache import complete:\n  Imported: ${result.imported}\n  Skipped: ${result.skipped}`,
          exitCode: 0
        };
      }
      case 'tune-ttl': {
        const status = cache.getAdaptiveTtlStatus();
        if (status.length === 0) {
          return {
            output: 'No adaptive TTLs configured. Set "adaptiveTtl: true" in your server config to enable.',
            exitCode: 0
          };
        }
        const formatTtl = (sec: number) => {
          if (sec >= 86400) return `${(sec / 86400).toFixed(1)}d`;
          if (sec >= 3600) return `${(sec / 3600).toFixed(1)}h`;
          return `${sec}s`;
        };
        const lines = status.map(s => {
          const arrow = s.effectiveTtl !== s.baseTtl ? '->' : '=';
          const lastAdj = s.lastAdjustedAt > 0
            ? `${Math.round((Date.now() / 1000 - s.lastAdjustedAt) / 60)}m ago`
            : 'never';
          return `  ${s.tool}: ${formatTtl(s.baseTtl)} ${arrow} ${formatTtl(s.effectiveTtl)}  ` +
            `(premature: ${(s.prematureRate * 100).toFixed(0)}%, ` +
            `evictions/h: ${s.evictionsLastHour}, ` +
            `adjusted: ${s.adjustmentCount}x, last: ${lastAdj})`;
        });
        const adapted = status.filter(s => s.effectiveTtl !== s.baseTtl).length;
        return {
          output: `Adaptive TTL Status (${adapted}/${status.length} tools adjusted):\n${lines.join('\n')}`,
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

interface WarmQuery {
  tool: string;
  args: unknown;
}

async function warmCache(
  queriesPath: string,
  cache: CacheStore,
  upstream: UpstreamManager,
  router: ToolRouter
): Promise<CliResult> {
  const results = {
    successful: 0,
    failed: 0,
    errors: [] as string[]
  };

  try {
    // Read queries file
    const queriesContent = await readFile(queriesPath, 'utf-8');
    const lines = queriesContent.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));

    if (lines.length === 0) {
      return {
        output: 'No queries found in file',
        exitCode: 0
      };
    }

    // Process each query
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const query = JSON.parse(line) as WarmQuery;

        if (!query.tool || !query.args) {
          results.errors.push(`Line ${i + 1}: Invalid query format (missing 'tool' or 'args')`);
          results.failed++;
          continue;
        }

        // Find which server handles this tool
        const serverName = router.findServerForTool(query.tool);
        if (!serverName) {
          results.errors.push(`Line ${i + 1}: No server found for tool '${query.tool}'`);
          results.failed++;
          continue;
        }

        // Call upstream server (bypassing cache)
        const result = await upstream.callTool(serverName, query.tool, query.args);

        // Store result in cache
        const key = await import('./keygen.js').then(m => m.generateKey(query.tool, query.args));
        const ttl = 43200; // Default TTL - could be made configurable
        await cache.set(key, query.tool, query.args, result, ttl);

        results.successful++;
        console.error(`[WARM] Warmed: ${query.tool}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.errors.push(`Line ${i + 1}: ${errorMsg}`);
        results.failed++;
      }
    }

    const output = [
      `Cache warming complete:`,
      `  Successful: ${results.successful}`,
      `  Failed: ${results.failed}`,
      results.errors.length > 0 ? `  Errors:\n    ${results.errors.join('\n    ')}` : ''
    ].filter(Boolean).join('\n');

    return {
      output,
      exitCode: results.failed > 0 ? 1 : 0
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      output: `Error reading queries file: ${errorMessage}`,
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
