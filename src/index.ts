#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { CacheStore } from './cache.js';
import { parseCliArgs, handleCliCommand } from './cli.js';

async function main() {
  const { args, errors, warnings } = parseCliArgs(process.argv.slice(2));

  // Report any warnings
  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }

  // Report any errors and exit
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`Error: ${error}`);
    }
    process.exit(1);
  }

  const configPath = args.configPath
    ? new URL(`file://${args.configPath}`)
    : new URL(`file://${process.env.HOME}/.mcp-cache-proxy/config.json`);

  const config = await loadConfig(configPath);
  const cache = new CacheStore(config.cache);

  if (args.mode !== 'server') {
    const result = await handleCliCommand(args, cache);
    console.log(result.output);
    process.exit(result.exitCode);
  }

  // Start MCP server mode
  // TODO: Initialize MCP server with tools from upstream servers
  console.error('Error: MCP server mode is not yet implemented.');
  console.error('For now, use CLI commands: --stats, --flush, --new, --help');
  process.exit(1);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
