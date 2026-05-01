# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP Cache Proxy is a TypeScript/Node.js proxy server that caches MCP (Model Context Protocol) tool calls to reduce API quota usage. The proxy implements the MCP server protocol over stdio and sits between MCP clients (Claude Code, Cursor, Copilot, etc.) and upstream MCP servers (search-prime, web-reader, zread), caching results in SQLite.

### Architecture

```
MCP Client (Claude Code, Cursor, Copilot, etc.)
       ↕ stdio
MCP Cache Proxy
       ↕ stdio/HTTP (per upstream server)
Real MCP Servers (search-prime, web-reader, zread, etc.)
       ↕
  SQLite cache (~/.mcp-cache-proxy/cache.db)
```

The proxy exposes a single MCP server connection that advertises the union of all cached servers' tools. When a tool is called, the proxy generates a cache key (SHA-256 of tool name + canonicalized arguments), checks SQLite, and returns cached results if fresh. Otherwise, it proxies to the upstream server and caches the response.

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
# Using npm global install (after npm install -g mcp-cache-proxy)
mcp-cache-proxy --stats
mcp-cache-proxy --flush
mcp-cache-proxy --flush search-prime  # per-tool
mcp-cache-proxy --warm --queries queries.txt
mcp-cache-proxy --export cache-backup.json
mcp-cache-proxy --import cache-backup.json

# Using dist/ directly (building from source)
node dist/index.js --stats
node dist/index.js --config ~/.mcp-cache-proxy/config.json
```

### Testing
```bash
npm test                    # All tests
npm test -- cache.test.ts   # Single test file
npm test -- --watch         # Watch mode
timeout 60s npm test 2>&1 | tail -30  # Use timeout; upstream.test.ts always hangs (~60s)
```

### Publishing
```bash
npm publish --ignore-scripts  # Must skip tests; upstream.test.ts hangs indefinitely
```

## Code Architecture

### Core Components

- **src/index.ts**: Entry point, stdio transport, server startup
- **src/upstream.ts**: Manages upstream MCP connections (stdio & HTTP), supports both StdioServerTransport and StreamableHTTPClientTransport
- **src/proxy.ts**: Tool routing to upstream MCP servers, wraps cache layer, negative caching
- **src/cache.ts**: SQLite operations (get/set/getWithStale/touch/flush/stats/export/import), TTL eviction, LRU, negative caching, per-tool stats, stale-while-revalidate, cost savings counter, adaptive TTL tuning, eviction tracking
- **src/keygen.ts**: Cache key generation (SHA-256, canonicalized args)
- **src/config.ts**: Config loading with global/project lookup and merge
- **src/cli.ts**: CLI flag parsing (--stats, --flush, --new, --warm, --export, --import, --tune-ttl, --config, --help)

### Cache Strategy

- **Key generation**: `sha256(tool_name + json_canonical(args))` — sorted keys, trimmed values, case-insensitive for search queries
- **TTL**: Per-tool configurable defaults (search-prime: 24h, web-reader: 6h, zread: 1h). Errors use `negativeCacheTtlSeconds` (default: 5min).
- **Stale-while-revalidate**: When `staleWhileRevalidateSeconds > 0`, expired entries are served immediately while a background refresh fetches fresh data. `getWithStale()` returns `{ value, stale }` to signal freshness.
- **Storage**: SQLite with WAL mode for concurrent read performance, indexes on `tool` and `created_at`
- **Eviction**: LRU when `maxSizeBytes` exceeded (default 100MB). Per-entry size capped by `maxEntrySizeBytes` (default: 10MB).
- **Mode**: Whitelist by default — only cache explicitly listed tools

### Configuration Location

- **Global config**: `~/.mcp-cache-proxy/config.json` — contains upstream server definitions
- **Project config**: `.mcp-cache-proxy.json` (optional) — overrides global settings with `extendGlobal: true`
- **Env var**: `MCP_CACHE_CONFIG` — custom config path (overrides defaults, overridden by --config flag)

### Server Configuration

**Stdio-based servers** (child processes):
```json
{
  "command": "npx",
  "args": ["-y", "@package/name"],
  "env": { "API_KEY": "" }
}
```

**HTTP-based servers** (POST endpoints):
```json
{
  "url": "https://api.example.com/mcp/endpoint",
  "env": { "AUTH_TOKEN": "" }
}
```

**Note:** Empty string in `env` means "use `process.env[key]`" — for HTTP servers, Z.ai uses `AUTH_TOKEN` header (not `Authorization`).

**Full server config options:**
```json
{
  "command": "npx", "args": ["-y", "@package/name"],
  "url": "https://api.example.com/mcp/endpoint",
  "env": { "API_KEY": "" },
  "cacheTtlSeconds": 43200,
  "negativeCacheTtlSeconds": 300,
  "adaptiveTtl": true,
  "cacheTtlRange": { "min": 3600, "max": 86400 }
}
```
Cache-level options (`cache` section): `path`, `maxSizeBytes`, `maxEntrySizeBytes`, `defaultTtlSeconds`, `negativeCacheTtlSeconds`, `staleWhileRevalidateSeconds`. See `config.example.json` for all options with defaults.

### Key Design Constraints

- Only cache read-only tools. Tools with side effects (writes, mutations) are never cached. Configurable blacklist defaults to: `browser_click`, `browser_type`, `browser_fill_form`, `Edit`, `Write`, `Bash`.
- Synchronous SQLite (`better-sqlite3`) for simplicity — no async complexity in cache layer.
- Single stdio connection to Claude Code — the proxy multiplexes all upstream tools under one server.
- Cache is shared across Claude Code sessions via SQLite file.

### Tool Name Routing

Tools are matched to upstream servers by prefix: `web_search_prime_*` → `web-search-prime` server. The proxy strips dashes from server names when matching (e.g., `web-search-prime` matches `web_search_prime`).

### Implementation Notes

- **LRU eviction**: Implemented — cache tracks entry sizes and evicts least recently used entries (lowest `(hits, created_at)` tuple) when `maxSizeBytes` is exceeded. Eviction targets 90% of max size to avoid frequent evictions. Wrapped in `this.db.transaction()` for atomicity.
- **Negative caching**: Errors cached with `is_error` flag and shorter TTL. `set()` extracts Error properties (message/name/stack) before JSON serialization since `JSON.stringify(new Error())` returns `{}`. `get()` reconstructs proper Error objects before throwing.
- **Per-tool stats**: `stats_by_tool` table tracks hits, misses, and size per tool. Updated by `set()`, `get()`, `flush()`, and `evictIfNeeded()`.
- **Export/import**: `exportCache()` writes JSON with sanitized errors (no stack traces). `importCache()` validates paths, skips existing/expired/oversized entries, preserves original TTL. `validateFilePath()` prevents path traversal.
- **SQLite gotchas**: Each `?` placeholder needs its own parameter — `ON CONFLICT SET x = x - ?` requires two values passed separately. Wrap multi-statement operations in `this.db.transaction()` for atomicity.
- **WAL mode**: Enabled on startup via `PRAGMA journal_mode = WAL` for concurrent read performance. `busy_timeout = 5000` handles lock contention.
- **Stale-while-revalidate**: `getWithStale()` returns `{ value, stale }` object instead of raw value. `touch()` updates existing entry in-place for background refresh. `proxy.ts` `callTool()` uses `getWithStale()` and fires `refreshInBackground()` for stale hits.
- **Cost savings**: `stats.saved_calls` tracks total avoided API calls. Incremented on every fresh or stale cache hit.
- **Adaptive TTL tuning**: Background adaptor runs every 10min (opt-in via `adaptiveTtl: true` per server). Analyzes eviction statistics from `eviction_stats` table — premature eviction rate (entries dying with 0 hits) drives TTL adjustments. High premature rate (>60%) → decrease TTL by 15%; low rate (<20%) → increase TTL by 20%. Effective TTLs stored in `adaptive_ttls` table, clamped to `cacheTtlRange` bounds. Requires minimum 5 evictions/hour before adjusting. `--tune-ttl` CLI shows diagnostic status.
- **Eviction tracking**: Every TTL expiry and LRU eviction recorded in `eviction_stats` table with `had_hits`, `size_bytes`, and `eviction_reason`. Stats cleaned up after 24h. Used by adaptive TTL adaptor.
- **upstream.test.ts**: Always hangs (~60s timeout) because it spawns real MCP server processes. This is a pre-existing issue unrelated to code changes. Never block on it — use `timeout` or run specific test files instead.
