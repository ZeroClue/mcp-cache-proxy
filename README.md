# MCP Cache Proxy

A caching proxy server for MCP (Model Context Protocol) tool calls. Reduces API quota by caching read-only tool results in SQLite.

## Features

- Transparent caching of MCP tool calls
- Configurable TTL per tool
- SQLite-based cache with LRU eviction
- MCP-standards compliant — works with any MCP client
- CLI for cache management (`--stats`, `--flush`, `--new`)
- Project-specific config overrides with global inheritance

## Installation

```bash
npm install
npm run build
```

## Configuration

Create `~/.mcp-cache-proxy/config.json`:

```json
{
  "servers": {
    "search-prime": {
      "command": "npx",
      "args": ["-y", "@zai-mcp/web-search-prime"],
      "cacheTtlSeconds": 86400
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

### As MCP Server

Add to your MCP client config (e.g., `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "cached-tools": {
      "command": "node",
      "args": ["/path/to/mcp-cache-proxy/dist/index.js"]
    }
  }
}
```

The proxy will expose all upstream tools plus cache management tools:
- `cache_stats()` — Get cache statistics
- `cache_flush(tool?)` — Flush cache entries
- `cache_new()` — Recreate cache database

### CLI

```bash
# Show cache statistics
mcp-cache-proxy --stats

# Flush all cache
mcp-cache-proxy --flush

# Flush specific tool's cache
mcp-cache-proxy --flush search-prime

# Recreate cache database (handles corruption)
mcp-cache-proxy --new

# Use custom config path
mcp-cache-proxy --config /path/to/config.json

### Environment Variable

You can also specify a custom config path using the `MCP_CACHE_CONFIG` environment variable:

```bash
export MCP_CACHE_CONFIG=/path/to/config.json
mcp-cache-proxy
```

The environment variable takes precedence over default lookup but is overridden by the `--config` flag.
```

## Cache Strategy

- **Key generation:** SHA-256 hash of tool name + canonicalized arguments (sorted keys, trimmed, case-insensitive)
- **Default TTLs:**
  - search-prime: 24 hours
  - web-reader: 6 hours
  - zread: 1 hour
  - Other: 12 hours
- **Eviction:** LRU when `maxSizeBytes` exceeded (default: 100MB)
- **Mode:** Whitelist by default — only cache explicitly configured tools

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Build and run proxy
npm test         # Run tests
```

## License

MIT
