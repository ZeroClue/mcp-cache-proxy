# MCP Cache Proxy

A caching proxy for MCP (Model Context Protocol) tool calls. Reduces API quota by caching read-only tool results in SQLite.

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

See `config.example.json` for full options.

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

### CLI

```bash
mcp-cache-proxy --stats
mcp-cache-proxy --flush [tool]
mcp-cache-proxy --new
```

## License

MIT
