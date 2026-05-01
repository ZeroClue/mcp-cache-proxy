# MCP Cache Proxy

A caching proxy server for MCP (Model Context Protocol) tool calls. Reduces API quota usage by caching read-only tool results in SQLite. Works with any MCP-compliant client (Claude Code, Cursor, Copilot, etc.).

## Features

- Transparent caching of MCP tool calls
- Configurable TTL per server
- SQLite-based cache with LRU size-based eviction
- Supports both stdio and HTTP-based MCP servers
- CLI for cache management (`--stats`, `--flush`, `--new`, `--warm`)
- Project-specific config overrides with global inheritance
- Cache warming for pre-loading frequently-used queries

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
      "cacheTtlSeconds": 86400
    },
    "web-reader-http": {
      "url": "https://api.example.com/mcp/web-reader",
      "env": {
        "API_KEY": ""
      },
      "cacheTtlSeconds": 21600
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

**Server types:**
- **Stdio servers:** Use `command` and `args` to spawn child processes
- **HTTP servers:** Use `url` for POST-based MCP endpoints

**Environment variables:** Empty string values (`"API_KEY": ""`) tell the proxy to use `process.env[KEY]` instead. Useful for keeping secrets out of config files.

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
- `cache_stats()` — Get cache statistics (cached, hits, hitRate, misses, sizeBytes)
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
node dist/index.js --stats

# Flush all cache
node dist/index.js --flush

# Flush specific tool's cache
node dist/index.js --flush search-prime

# Recreate cache database (handles corruption)
node dist/index.js --new

# Warm cache with pre-defined queries
node dist/index.js --warm --queries queries.txt

# Use custom config path
node dist/index.js --config /path/to/config.json

# Show help
node dist/index.js --help
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

## Cache Strategy

- **Key generation:** SHA-256 hash of tool name + canonicalized arguments (sorted keys, trimmed, case-insensitive)
- **Default TTLs:**
  - search-prime: 24 hours
  - web-reader: 6 hours
  - zread: 1 hour
  - Other: 12 hours (defaultTtlSeconds)
- **Eviction:** LRU when `maxSizeBytes` exceeded (default: 100MB)
  - Entries evicted by `(hits ASC, created_at ASC)` — least used/oldest first
  - Eviction targets 90% of max size to avoid frequent re-eviction
- **Mode:** Whitelist by default — only cache explicitly configured tools

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
