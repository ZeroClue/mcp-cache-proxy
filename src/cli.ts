import type { CacheStore } from './cache.js';

export interface CliArgs {
  mode: 'server' | 'stats' | 'flush' | 'new';
  tool?: string;
  configPath?: string;
  queriesPath?: string;
}

export interface CliResult {
  output: string;
  exitCode: number;
}

export function parseCliArgs(args: string[]): CliArgs {
  const result: CliArgs = { mode: 'server' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--stats':
        result.mode = 'stats';
        break;
      case '--flush':
        result.mode = 'flush';
        result.tool = args[i + 1];
        i++;
        break;
      case '--new':
        result.mode = 'new';
        break;
      case '--config':
        result.configPath = args[++i];
        break;
      default:
        if (result.mode === 'flush' && !result.tool && !arg.startsWith('--')) {
          result.tool = arg;
        }
    }
  }

  return result;
}

export async function handleCliCommand(args: CliArgs, cache: CacheStore): Promise<CliResult> {
  switch (args.mode) {
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
}
