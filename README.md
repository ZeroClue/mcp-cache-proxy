# MCP Cache Proxy

A caching proxy server for MCP (Model Context Protocol) tool calls. Reduces API quota usage by caching read-only tool results in SQLite. Works with any MCP-compliant client (Claude Code, Cursor, Copilot, etc.).

## Features

- Transparent caching of MCP tool calls
- Configurable TTL per server
- SQLite-based cache with LRU size-based eviction
- **Stale-while-revalidate** — serve stale data immediately, refresh in background
- **WAL mode** — concurrent read performance for multi-process access
- **Cost savings counter** — tracks avoided API calls in stats
- **Adaptive TTL tuning** — automatically adjusts TTLs based on eviction patterns (opt-in per server)
- Supports both stdio and HTTP-based MCP servers
- **Negative caching** for errors with configurable TTL
- **Per-entry size limits** to prevent cache bloat
- **Cache export/import** for backup and transfer
- CLI for cache management (`--stats`, `--flush`, `--new`, `--warm`, `--export`, `--import`, `--tune-ttl`)
- Per-tool cache statistics for monitoring and optimization
- Project-specific config overrides with global inheritance

## Installation

### Option 1: Install via npm (Recommended)

```bash
# Install globally
npm install -g mcp-cache-proxy

# Or use directly without installing (via npx)
npx mcp-cache-proxy --stats
```

After installation, the `mcp-cache-proxy` command is available globally:

```bash
mcp-cache-proxy --help
mcp-cache-proxy --stats
```

### Option 2: Build from source

```bash
# Clone repository
git clone https://github.com/username/mcp-cache-proxy.git
cd mcp-cache-proxy

# Install dependencies and build
npm install
npm run build

# Run directly
node dist/index.js --help
```

### Requirements

- Node.js >= 20.0.0
- npm (comes with Node.js)

## Configuration

Create `~/.mcp-cache-proxy/config.json`:

```json
{
  "servers": {
    "search-prime": {
      "command": "npx",
      "args": ["-y", "@zai-mcp/web-search-prime"],
      "cacheTtlSeconds": 86400,
      "negativeCacheTtlSeconds": 300
    },
    "web-reader-http": {
      "url": "https://api.example.com/mcp/web-reader",
      "env": {
        "API_KEY": ""
      },
      "cacheTtlSeconds": 21600,
      "negativeCacheTtlSeconds": 600
    }
  },
  "cache": {
    "path": "~/.mcp-cache-proxy/cache.db",
    "maxSizeBytes": 104857600,
    "maxEntrySizeBytes": 10485760,
    "defaultTtlSeconds": 43200,
    "negativeCacheTtlSeconds": 300
  },
  "mode": "whitelist"
}
```

**Server types:**
- **Stdio servers:** Use `command` and `args` to spawn child processes
- **HTTP servers:** Use `url` for POST-based MCP endpoints

**Environment variables:** Empty string values (`"API_KEY": ""`) tell the proxy to use `process.env[KEY]` instead. Useful for keeping secrets out of config files.

**Server configuration options:**
- `cacheTtlSeconds`: Time-to-live for successful responses (default: 43200 = 12 hours)
- `negativeCacheTtlSeconds`: Time-to-live for error responses (default: 300 = 5 minutes)
- `adaptiveTtl`: Enable automatic TTL adjustment based on eviction patterns (default: false)
- `cacheTtlRange`: Min/max bounds for adaptive TTL adjustments, e.g. `{ "min": 3600, "max": 86400 }`

**Cache configuration options:**
- `maxSizeBytes`: Maximum total cache size before eviction (default: 104857600 = 100MB)
- `maxEntrySizeBytes`: Maximum size for individual cache entries (default: 10485760 = 10MB)
- `defaultTtlSeconds`: Default TTL for servers without explicit config (default: 43200)
- `negativeCacheTtlSeconds`: Default negative cache TTL for errors (default: 300)
- `staleWhileRevalidateSeconds`: Grace period after TTL expiry to serve stale data while refreshing (default: 0 = disabled)

See `config.example.json` for all options.

### Project-Specific Config

Create `.mcp-cache-proxy.json` in your project directory:

```json
{
  "extendGlobal": true,
  "servers": {
    "search-prime": {
      "cacheTtlSeconds": 3600
    }
  }
}
```

With `extendGlobal: true` (default), project config merges with global config. Set to `false` to use standalone.

## Usage

The proxy runs as an MCP server and exposes all upstream tools plus cache management tools.

### Cache Management Tools

The proxy adds these tools to any MCP client:
- `cache_stats()` — Get cache statistics including per-tool breakdown (cached, hits, hitRate, misses, sizeBytes, staleHits, savedCalls, byTool)
- `cache_flush(tool?)` — Flush cache entries (all or specific tool)
- `cache_new()` — Recreate cache database

### Client Configuration

After installing via npm, configure your MCP client to use the `mcp-cache-proxy` command:

**Claude Code** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "cached-tools": {
      "command": "mcp-cache-proxy"
    }
  }
}
```

**Cursor** (Settings → MCP):
```json
{
  "mcpServers": {
    "cached-tools": {
      "command": "mcp-cache-proxy"
    }
  }
}
```

**Copilot CLI** (`~/.config/github-copilot-cli/mcp.json` or similar):
```json
{
  "mcpServers": {
    "cached-tools": {
      "command": "mcp-cache-proxy"
    }
  }
}
```

**Building from source?** Use the full path:
```json
{
  "mcpServers": {
    "cached-tools": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-cache-proxy/dist/index.js"]
    }
  }
}
```

**General MCP Client:**
Any MCP-compliant client can connect to this proxy via stdio. Consult your client's documentation for MCP server configuration.

### CLI Commands

```bash
# Show cache statistics
mcp-cache-proxy --stats

# Flush all cache
mcp-cache-proxy --flush

# Flush specific tool's cache
mcp-cache-proxy --flush search-prime

# Recreate cache database (handles corruption)
mcp-cache-proxy --new

# Warm cache with pre-defined queries
mcp-cache-proxy --warm --queries queries.txt

# Export cache to JSON file
mcp-cache-proxy --export cache-backup.json

# Import cache from JSON file
mcp-cache-proxy --import cache-backup.json

# Show adaptive TTL diagnostic status
mcp-cache-proxy --tune-ttl

# Use custom config path
mcp-cache-proxy --config /path/to/config.json

# Show help
mcp-cache-proxy --help
```

### Environment Variable

Specify a custom config path using `MCP_CACHE_CONFIG`:

```bash
export MCP_CACHE_CONFIG=/path/to/config.json
node dist/index.js
```

The environment variable takes precedence over default lookup but is overridden by the `--config` flag.

### Cache Warming

Pre-load cache with frequently-used queries:

```bash
node dist/index.js --warm --queries queries.txt
```

**queries.txt format** (one JSON query per line, `#` for comments):

```json
{"tool": "web_search_prime", "args": {"search_query": "typescript best practices"}}
{"tool": "web-reader", "args": {"url": "https://example.com"}}
# This is a comment
{"tool": "mcp__mcp-cache-proxy__analyze_image", "args": {"imageSource": "https://example.com/image.jpg", "prompt": "Describe this image"}}
```

See `queries.example.txt` for a complete example.

### Cache Export/Import

Export and import cache contents for backup or transfer between machines:

```bash
# Export cache to JSON file
mcp-cache-proxy --export cache-backup.json

# Import cache from JSON file
mcp-cache-proxy --import cache-backup.json
```

**Export format:** JSON file with version info, timestamp, and entries array. Each entry includes key, tool, args, result, timestamps, and error status.

**Import behavior:**
- Skips entries that already exist (based on key)
- Skips expired entries (TTL already passed)
- Skips entries exceeding `maxEntrySizeBytes`
- Adjusts TTL to preserve original expiration time
- Updates per-tool statistics

**Use cases:**
- Backup cache before clearing or upgrading
- Share cache between machines
- Pre-seed cache with known good results
- Debugging and analysis

## Cache Strategy

- **Key generation:** SHA-256 hash of tool name + canonicalized arguments (sorted keys, trimmed, case-insensitive)
- **Default TTLs:**
  - search-prime: 24 hours
  - web-reader: 6 hours
  - zread: 1 hour
  - Other: 12 hours (defaultTtlSeconds)
- **Stale-while-revalidate:** When enabled (`staleWhileRevalidateSeconds > 0`), expired entries are served immediately while fresh data is fetched in the background. The user never waits for a cache refresh.
- **Eviction:** LRU when `maxSizeBytes` exceeded (default: 100MB)
  - Entries evicted by `(hits ASC, created_at ASC)` — least used/oldest first
  - Eviction targets 90% of max size to avoid frequent re-eviction
- **Mode:** Whitelist by default — only cache explicitly configured tools
- **WAL mode:** SQLite uses Write-Ahead Logging for concurrent read performance. `busy_timeout = 5000ms` handles lock contention gracefully.
- **Adaptive TTL tuning:** Enable with `adaptiveTtl: true` per server. A background adaptor analyzes eviction statistics every 10 minutes — entries that expire without being accessed (premature evictions) signal the TTL is too long. The adaptor automatically decreases TTL when premature eviction rate is high (>60%) and increases it when most evicted entries had hits (<20%). Use `--tune-ttl` to view diagnostic status.

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Build and run proxy
npm test         # Run tests
npm run lint     # ESLint
```

## Updating

```bash
# Update to latest version
npm update -g mcp-cache-proxy

# Or reinstall specific version
npm install -g mcp-cache-proxy@latest

# Check installed version
mcp-cache-proxy --version  # (if implemented) or
npm list -g mcp-cache-proxy
```

## Architecture

```
MCP Client (Claude Code, Cursor, Copilot, etc.)
       ↕ stdio
MCP Cache Proxy
       ↕ stdio/HTTP (per upstream server)
Real MCP Servers (search-prime, web-reader, zread, etc.)
       ↕
  SQLite cache (~/.mcp-cache-proxy/cache.db)
```

The proxy:
1. Accepts tool calls from Claude Code over stdio
2. Generates cache key from tool name + arguments
3. Checks SQLite for cached result
4. On miss: calls upstream server, caches result with TTL
5. On hit: returns cached result, increments hit counter
6. Auto-evicts when cache size exceeds maxSizeBytes (LRU)

## Contributing

Before publishing, update repository URLs in `package.json`:
- `repository.url`
- `bugs.url`
- `homepage`

Replace `username` with your actual GitHub username.

## License

MIT
