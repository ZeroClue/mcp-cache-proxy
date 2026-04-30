# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP Cache Proxy is a TypeScript/Node.js proxy server that caches MCP (Model Context Protocol) tool calls to reduce API quota usage. The proxy implements the MCP server protocol over stdio and sits between Claude Code and upstream MCP servers (search-prime, web-reader, zread), caching results in SQLite.

### Architecture

```
Claude Code (MCP client)
       ↕ stdio
MCP Cache Proxy
       ↕ stdio (per upstream server)
Real MCP Servers (search-prime, web-reader, zread, etc.)
       ↕
  SQLite cache (~/.mcp-cache-proxy/cache.db)
```

The proxy exposes a single MCP server connection to Claude Code that advertises the union of all cached servers' tools. When a tool is called, the proxy generates a cache key (SHA-256 of tool name + canonicalized arguments), checks SQLite, and returns cached results if fresh. Otherwise, it proxies to the upstream server and caches the response.

## Commands

### Development
```bash
npm install          # Install dependencies
npm run build        # Build TypeScript to dist/
npm run dev          # Build + start proxy (stdio mode)
npm run test         # Run unit and integration tests
npm run lint         # ESLint
```

### CLI
```bash
# Start proxy (stdin/stdout MCP transport)
node dist/index.js

# Custom config
node dist/index.js --config ~/.mcp-cache-proxy/config.json

# Cache stats
node dist/index.js --stats

# Flush cache
node dist/index.js --flush
node dist/index.js --flush search-prime  # per-tool

# Warm cache (pre-fetch queries)
node dist/index.js --warm --queries queries.txt
```

### Testing
```bash
npm test                    # All tests
npm test -- cache.test.ts   # Single test file
npm test -- --watch         # Watch mode
```

## Code Architecture

### Core Components

- **src/index.ts**: Entry point, stdio transport, server startup
- **src/proxy.ts**: Tool routing to upstream MCP servers, wraps cache layer
- **src/cache.ts**: SQLite operations (get/set/flush/stats), TTL eviction, LRU
- **src/keygen.ts**: Cache key generation (SHA-256, canonicalized args)
- **src/config.ts**: Config loading from ~/.mcp-cache-proxy/config.json
- **src/cli.ts**: CLI flag parsing (--stats, --flush, --warm, --config)

### Cache Strategy

- **Key generation**: `sha256(tool_name + json_canonical(args))` — sorted keys, trimmed values, case-insensitive for search queries
- **TTL**: Per-tool configurable defaults (search-prime: 24h, web-reader: 6h, zread: 1h)
- **Storage**: SQLite with indexes on `tool` and `created_at`
- **Eviction**: LRU when maxSizeBytes exceeded (default 100MB)
- **Mode**: Whitelist by default — only cache explicitly listed tools

### Configuration Location

`~/.mcp-cache-proxy/config.json` — contains upstream server definitions (command, args, cacheTtlSeconds), cache settings (path, maxSizeBytes, defaultTtlSeconds), and mode (whitelist/blacklist).

### Key Design Constraints

- Only cache read-only tools. Tools with side effects (writes, mutations) are never cached. Configurable blacklist defaults to: `browser_click`, `browser_type`, `browser_fill_form`, `Edit`, `Write`, `Bash`.
- Synchronous SQLite (`better-sqlite3`) for simplicity — no async complexity in cache layer.
- Single stdio connection to Claude Code — the proxy multiplexes all upstream tools under one server.
- Cache is shared across Claude Code sessions via SQLite file.
