# MCP Cache Proxy

**Status:** Spec
**Estimated effort:** Weekend build (~2-3 days)
**Language:** TypeScript/Node.js (fits existing stack)

## Problem

MCP tool calls (search-prime, web-reader, zread) are metered at 1,000/month on the GLM Pro plan. Agents frequently search for the same things — repo structures, documentation, error messages — burning quota on duplicate queries. A caching proxy eliminates redundant calls by returning cached results on repeat queries.

## Architecture

```
Claude Code (MCP client)
       ↕ stdio/SSE
MCP Cache Proxy (this project)
       ↕ stdio/SSE
Real MCP Servers (search-prime, web-reader, zread, etc.)
       ↕
  SQLite cache (local file)
```

The proxy implements the MCP server protocol (stdio transport) and acts as both an MCP server (to Claude Code) and an MCP client (to real servers). Claude Code connects to the proxy instead of directly to the tool servers.

## Cache Strategy

### Key generation
Hash the tool name + normalized arguments (sorted keys, trimmed values, case-insensitive for search queries). SHA-256 hex digest as cache key.

```
key = sha256(tool_name + json_canonical(args))
```

### TTL (time-to-live)
| Tool | Default TTL | Rationale |
|------|-------------|-----------|
| search-prime | 24 hours | Search results change slowly |
| web-reader | 6 hours | Page content may update |
| zread (repo reader) | 1 hour | Repo content changes during active work |
| Other read tools | 12 hours | Conservative default |

Configurable per-tool via config file.

### Cache storage
SQLite with a single table:
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
- Manual flush: `--flush` CLI flag or `DELETE FROM cache`
- Size limit: default 100MB, LRU eviction when exceeded
- Per-tool flush: `--flush search-prime`

### What NOT to cache
Tools with side effects (file writes, API mutations). Configurable blacklist:
```json
{
  "blacklist": ["browser_click", "browser_type", "browser_fill_form", "Edit", "Write", "Bash"]
}
```
By default, only cache tools explicitly listed in the whitelist (search-prime, web-reader, zread). Everything else passes through uncached.

## Configuration

`~/.mcp-cache-proxy/config.json`:
```json
{
  "servers": {
    "search-prime": {
      "command": "npx",
      "args": ["-y", "@zai-mcp/web-search-prime"],
      "cacheTtlSeconds": 86400
    },
    "web-reader": {
      "command": "npx",
      "args": ["-y", "@zai-mcp/web-reader"],
      "cacheTtlSeconds": 21600
    },
    "zread": {
      "command": "npx",
      "args": ["-y", "@zai-mcp/zread"],
      "cacheTtlSeconds": 3600
    }
  },
  "cache": {
    "path": "~/.mcp-cache-proxy/cache.db",
    "maxSizeBytes": 104857600,
    "defaultTtlSeconds": 43200
  },
  "mode": "whitelist"
}
```

`mode: "whitelist"` = only cache listed tools (safe default). `mode: "blacklist"` = cache everything except listed tools.

## Integration with Claude Code

In `~/.claude/settings.json` or project `.claude/settings.json`, replace direct MCP server definitions with the proxy:

```json
{
  "mcpServers": {
    "search-prime": {
      "command": "node",
      "args": ["/path/to/mcp-cache-proxy/dist/index.js", "--config", "~/.mcp-cache-proxy/config.json"]
    },
    "web-reader": {
      "command": "node",
      "args": ["/path/to/mcp-cache-proxy/dist/index.js", "--config", "~/.mcp-cache-proxy/config.json"]
    }
  }
}
```

Wait — that won't work for multiple tools through one proxy entry. Better approach: the proxy is a single MCP server that exposes ALL the cached tools under one connection. Claude Code sees one server with `search_prime_web_search`, `web_reader_webReader`, `zread_read_file` etc.

```json
{
  "mcpServers": {
    "cached-tools": {
      "command": "node",
      "args": ["/path/to/mcp-cache-proxy/dist/index.js"],
      "env": {
        "MCP_CACHE_CONFIG": "~/.mcp-cache-proxy/config.json"
      }
    }
  }
}
```

The proxy advertises the union of all cached servers' tools. When a tool is called, the proxy routes to the correct upstream server.

## CLI Interface

```bash
# Start proxy (stdin/stdout MCP transport)
mcp-cache-proxy

# Start with custom config
mcp-cache-proxy --config /path/to/config.json

# Cache stats
mcp-cache-proxy --stats
# Output: 847 cached, 312 hits (36.8%), 3 misses today, 52MB used

# Flush cache
mcp-cache-proxy --flush
mcp-cache-proxy --flush search-prime  # per-tool

# Warm cache (pre-fetch common queries)
mcp-cache-proxy --warm --queries queries.txt
```

## Project Structure

```
mcp-cache-proxy/
  src/
    index.ts          # Entry point, MCP server transport
    proxy.ts          # Tool routing to upstream servers
    cache.ts          # SQLite cache layer
    config.ts         # Config loading
    keygen.ts         # Cache key generation
    cli.ts            # CLI interface (--stats, --flush, --warm)
  config.example.json
  package.json
  tsconfig.json
  README.md
```

## Dependencies (minimal)

- `better-sqlite3` — SQLite bindings (fast, synchronous, no async complexity)
- `@modelcontextprotocol/sdk` — MCP protocol implementation
- No other runtime dependencies

## Testing

- Unit: cache hit/miss, TTL expiry, key generation, LRU eviction
- Integration: proxy → real MCP server → cached response → proxy → cache hit
- Mock upstream server for deterministic tests

## Expected Impact

Based on current usage (~833 MCP calls/month, ~23/day):
- Estimated cache hit rate: 40-60% (many repeated searches for same repos/docs)
- Projected savings: 330-500 calls/month
- Breakeven: proxy pays for itself within the first billing cycle

## Open Questions

1. Should the proxy support SSE transport (for remote MCP servers) or just stdio?
2. Should cache be shared across multiple Claude Code sessions (yes — SQLite file)
3. Semantic caching (similar queries, not just exact match) — phase 2 or overkill?
4. Should we log/cache misses for analysis (which queries are unique vs repeated)?
