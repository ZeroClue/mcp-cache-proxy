# MCP Cache Proxy - Cascading Failover Fix

## Summary

Fixed the cascading failover bug by implementing **tool name mapping** to translate tool names across different upstream servers during failover.

## Problem

The original failover implementation had two critical issues:

1. **Architecture Bug**: The `upstream` function was pre-bound to a specific server name, preventing the failover loop from actually calling different servers.

2. **Tool Name Mismatch**: Different upstream servers use different tool names (e.g., Z.AI's `web_search_prime` vs SearXNG's `searxng_web_search`). When failing over, the proxy tried to call the same tool name on all servers, which failed because the tool didn't exist.

## Solution

### 1. Refactored Server Calling Architecture
- Modified `src/index.ts` to pass `UpstreamManager` to `ToolRouter` instead of a pre-bound function
- This allows the failover loop to dynamically call different servers

### 2. Implemented Tool Name Mapping
- Added `toolMappings` configuration to `FailoverConfig` interface
- Format: `{"source-server": {"source-tool": "target-server:target-tool"}}`
- Example: `{"web-search-prime": {"web_search_prime": "searxng:searxng_web_search"}}`
- Added `mapToolName()` method to `ToolRouter` to translate tool names during failover
- Added validation in `config.ts` to ensure mappings are well-formed

### 3. Fixed Priority Strategy
- Modified `applyFailoverStrategy()` to always try the requested server first
- Remaining candidates are sorted by priority
- This ensures the intended server is tried before falling back to alternatives

## Configuration

Add to `~/.mcp-cache-proxy/config.json`:

```json
{
  "failover": {
    "enabled": true,
    "strategy": "priority",
    "onErrors": ["quota_exceeded", "timeout", "http_429", "http_5xx", "connection_refused"],
    "cacheByActualServer": true,
    "maxRetries": 3,
    "toolMappings": {
      "web-search-prime": {
        "web_search_prime": "searxng:searxng_web_search"
      }
    }
  }
}
```

## Server Configuration

Servers must be tagged to participate in failover:

```json
{
  "servers": {
    "web-search-prime": {
      "url": "https://api.z.ai/api/mcp/web_search_prime/mcp",
      "priority": 2,
      "tags": ["web-search"],
      "cacheTtlSeconds": 86400
    },
    "searxng": {
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "priority": 1,
      "tags": ["web-search"],
      "cacheTtlSeconds": 86400
    }
  }
}
```

## How It Works

1. **Tool Call Request**: Client calls `web_search_prime` (intended for `web-search-prime` server)
2. **Cache Check**: Proxy checks cache first (miss in this scenario)
3. **Failover Candidate Selection**: Proxy finds all servers with matching tags (`web-search`)
4. **Priority Ordering**: `web-search-prime` (priority 2) is first, then `searxng` (priority 1)
5. **First Attempt**: Try `web-search-prime` with tool `web_search_prime` → **FAILS** (quota exceeded)
6. **Failover Decision**: Error type is `quota_exceeded`, which is in `onErrors` list → retry next candidate
7. **Tool Name Mapping**: Map `web_search_prime` to `searxng_web_search` for the `searxng` server
8. **Second Attempt**: Try `searxng` with tool `searxng_web_search` → **SUCCESS**
9. **Cache Result**: Store with server-specific cache key (if `cacheByActualServer: true`)

## Test Results

```
Testing failover with tool name mapping...

✓ Config loaded
✓ Tools registered

--- Test 1: Failover from web-search-prime to searxng ---
[FAILOVER] tool=web_search_prime server=web-search-prime attempt=1 error=quota_exceeded retryable=true
[FAILOVER] tool=web_search_prime (searxng_web_search) requested=web-search-prime actual=searxng attempt=2 success=true
✓ Failover successful
✓ Tool name mapping worked correctly

--- Test 2: No failover when primary succeeds ---
✓ Call succeeded
✓ Primary server was used (no failover)

✓ All failover tests passed
```

## Files Modified

1. `src/config.ts` - Added `toolMappings` to `FailoverConfig`, added validation
2. `src/proxy.ts` - Added `mapToolName()`, fixed priority strategy, updated failover loop
3. `~/.mcp-cache-proxy/config.json` - Added tool mappings configuration

## Benefits

- **Seamless Failover**: Clients automatically switch to backup servers when primary fails
- **Tool Translation**: Handles different tool naming conventions across servers
- **Cache Integrity**: Server-specific cache keys prevent cross-server pollution
- **Flexible Strategies**: Supports priority, round-robin, and random ordering
- **Configurable**: Fine-grained control over which errors trigger failover

## Next Steps

Consider adding:
- More comprehensive monitoring and alerting for failover events
- Health checks to proactively detect failing servers
- Circuit breaker pattern to temporarily skip failing servers
- Additional tool mappings for other server combinations (e.g., vision tools, GitHub tools)
