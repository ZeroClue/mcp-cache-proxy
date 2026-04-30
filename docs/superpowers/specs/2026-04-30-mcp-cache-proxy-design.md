# MCP Cache Proxy Design

**Date:** 2026-04-30
**Status:** Approved
**Effort:** Weekend build (~2-3 days)

## Overview

MCP Cache Proxy is a TypeScript/Node.js proxy server that caches MCP (Model Context Protocol) tool calls to reduce API quota usage. The proxy sits between Claude Code (or any MCP client) and upstream MCP servers, caching read-only tool results in SQLite.

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

The proxy implements the MCP server protocol over stdio and exposes a single server connection that advertises the union of all cached servers' tools. When a tool is called, the proxy:

1. Checks if the tool is cacheable (whitelist/blacklist mode)
2. Generates a cache key (SHA-256 of tool name + canonicalized args)
3. Looks up in SQLite — returns cached result if fresh
4. Otherwise, forwards to upstream server, caches response, returns it

## Configuration

### Config File Locations

Lookup order (first found wins):
1. `--config` CLI flag (explicit path)
2. `MCP_CACHE_CONFIG` environment variable
3. `.mcp-cache-proxy.json` in current working directory (project-specific)
4. `~/.mcp-cache-proxy/config.json` (global default)

### Project Config Merge

Project configs merge with global config when `extendGlobal: true` (default):
- Deep merge: project values override global values
- Arrays are replaced, not merged
- Warn when overriding a global server definition
- Invalid project config fails fast (doesn't silently fall back)

Set `extendGlobal: false` for standalone project config that ignores global.

### Config Format

```json
{
  "servers": {
    "search-prime": {
      "command": "npx",
      "args": ["-y", "@zai-mcp/web-search-prime"],
      "env": { "API_KEY": "xxx" },
      "cacheTtlSeconds": 86400
    }
  },
  "cache": {
    "path": "~/.mcp-cache-proxy/cache.db",
    "maxSizeBytes": 104857600,
    "defaultTtlSeconds": 43200
  },
  "mode": "whitelist",
  "extendGlobal": true
}
```

The `servers` section conforms to the standard MCP client config format per the [MCP specification](https://spec.modelcontextprotocol.io/specification/client/). The `cacheTtlSeconds` field is a proxy-specific extension.

## Cache Strategy

### Key Generation

```typescript
key = sha256(tool_name + json_canonical(args))
```

Canonicalization:
- Strings are trimmed and lowercased (case-insensitive matching)
- Object keys are sorted recursively
- Tool name is prefixed to prevent cross-tool collisions

### TTL Defaults

| Tool | Default TTL | Rationale |
|------|-------------|-----------|
| search-prime | 24 hours | Search results change slowly |
| web-reader | 6 hours | Page content may update |
| zread (repo reader) | 1 hour | Repo content changes during active work |
| Other read tools | 12 hours | Conservative default |

### SQLite Schema

```sql
CREATE TABLE cache (
  key TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hits INTEGER DEFAULT 0,
  ttl_seconds INTEGER NOT NULL
);
CREATE INDEX idx_cache_tool ON cache(tool);
CREATE INDEX idx_cache_created ON cache(created_at);
```

### Invalidation

- TTL-based expiry (checked on read)
- Manual flush via `cache_flush` tool or `--flush` CLI flag
- LRU eviction when `maxSizeBytes` exceeded (default 100MB)
- Per-tool flush supported

### Cacheable Tools

**Mode: whitelist** (default) — Only cache explicitly listed tools.
**Mode: blacklist** — Cache everything except listed tools.

Tools with side effects are never cached. Default blacklist:
```
browser_click, browser_type, browser_fill_form, Edit, Write, Bash
```

## Module Structure

```
src/
  index.ts    — Entry point: CLI parsing, stdio server startup
  proxy.ts    — ToolRouter class: routes tools to cache or upstream
  cache.ts    — CacheStore class: SQLite CRUD, TTL, LRU, stats
  keygen.ts   — generateKey(): canonicalizes args, returns SHA-256
  config.ts   — loadConfig(): reads and validates config files
  cli.ts      — handleCliFlags(): --stats, --flush, --warm, --new
```

Each file exports one main class/function. No shared state — everything passes through constructors or parameters.

## MCP Tools

The proxy exposes two categories of tools:

### Upstream Tools (Cached)

Passthrough tools from upstream servers, re-advertised under the proxy's server. Tool names retain their original prefix (e.g., `search_prime_web_search`, `web_reader_webReader`).

### Cache Management Tools (Not Cached)

- `cache_stats()` — Returns cache statistics (cached count, hits, hit rate, misses, size)
- `cache_flush(tool?)` — Flush cache entries, optionally per-tool
- `cache_warm(queries[])` — Pre-populate cache with queries (array of `{tool, args}`)
- `cache_new()` — Drop and recreate database (handles corruption)

## CLI Interface

```bash
# Start proxy (stdio mode)
mcp-cache-proxy

# Custom config path
mcp-cache-proxy --config /path/to/config.json

# Cache management (proxies to cache management tools)
mcp-cache-proxy --stats
mcp-cache-proxy --flush [tool]
mcp-cache-proxy --warm --queries queries.txt
mcp-cache-proxy --new
```

CLI mode doesn't spawn upstream servers — only touches cache. `--warm` is the only mode that calls upstream servers.

## Error Handling

| Error Type | Behavior |
|------------|----------|
| Config errors | Fail fast on startup. Log to stderr, exit non-zero. |
| Cache errors | Log warning, fallback to passthrough mode. Don't fail proxy. |
| Upstream errors | Pass through to client unchanged. Don't cache failures. |

Principle: Cache failures never break tool execution. Upstream failures are transparent passthrough.

## Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/better-sqlite3": "^7.6.0",
    "typescript": "^5.0.0"
  }
}
```

No testing framework — using Node's built-in `node:test` and `node:assert`.

Build: `tsc` only. Output is `dist/index.js`, invoked directly by MCP clients.

## Logging

- All logs go to stderr (stdio reserved for MCP protocol)
- Log levels: `error`, `warn`, `info` — controlled by `LOG_LEVEL` env var (default: `info`)
- On cache hit: `tool=args (cached)`
- On cache miss: `tool=args (miss, calling upstream)`
- On upstream error: `upstream error: tool=args`

No file logging, no structured logging.

## Testing

### Unit Tests

`cache.test.ts`: CacheStore CRUD, TTL expiry, key generation, LRU eviction. Uses in-memory SQLite.

### Integration Tests

`proxy.test.ts`: Mock upstream MCP server, verify tool call routing, cache hit/miss behavior.

### CLI Tests

`cli.test.ts`: Flag parsing, --stats output format, --flush clears cache.

No e2e tests with real upstream servers. Framework: `node:test`.

## Upstream Server Communication

The proxy spawns each upstream server as a child process with stdio pipes. Maintains a `Map<string, McpClient>` of active connections. Connections persist for the proxy's lifetime — no new process per tool call.

Using `@modelcontextprotocol/sdk`'s client class for protocol handling.

## MCP Standards Compliance

The proxy strictly follows the [Model Context Protocol specification](https://spec.modelcontextprotocol.io/) to ensure compatibility with any MCP-compliant client, not just Claude Code.
