# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-05-02

### Added

- **Stale-while-revalidate**: Serve expired cache data immediately while refreshing in background
  - New `staleWhileRevalidateSeconds` config option (default: 0 = disabled)
  - New `getWithStale()` method returns `{ value, stale }` to signal data freshness
  - New `touch()` method updates existing cache entries in-place for background refresh
  - `proxy.ts` `callTool()` uses stale-while-revalidate pattern when enabled
  - Background refresh failures are silently ignored — stale data is still served

- **Cost savings counter**: Tracks total API calls avoided by serving from cache
  - New `savedCalls` field in `cache_stats()` output
  - Incremented on every fresh and stale cache hit
  - Backfilled from existing hit data during schema migration

- **WAL mode**: SQLite uses Write-Ahead Logging for concurrent read performance
  - `PRAGMA journal_mode = WAL` enabled on startup
  - `PRAGMA busy_timeout = 5000` handles lock contention gracefully
  - Allows concurrent reads while a write is in progress

- **Adaptive eviction-aware TTL tuning**: Background adaptor automatically adjusts TTLs based on eviction patterns
  - New `adaptiveTtl: true` per-server config opt-in
  - New `cacheTtlRange: { min, max }` per-server config to clamp adjustments
  - Analyzes `eviction_stats` table — premature eviction rate (entries dying with 0 hits) drives adjustments
  - High premature rate (>60%) → decrease TTL by 15%; low rate (<20%) → increase TTL by 20%
  - Requires minimum 5 evictions/hour before adjusting
  - `--tune-ttl` CLI repurposed as read-only diagnostic (shows effective TTLs, eviction rates, adjustment count)
  - Effective TTLs persist in `adaptive_ttls` table across restarts
  - Base TTL updated from config on restart (via `ON CONFLICT DO UPDATE`)

- **Eviction tracking**: Records every cache eviction with context for adaptive tuning
  - New `eviction_stats` table tracks `had_hits`, `size_bytes`, and `eviction_reason` per eviction
  - Records expired, stale-expired, and LRU evictions
  - Stats automatically cleaned up after 24 hours

### Fixed

- **Stale hits counted as misses**: `getWithStale()` now correctly increments `hits` instead of `misses` in `stats_by_tool`
- **Fresh hits not counted in per-tool stats**: `getWithStale()` now increments `stats_by_tool.hits` for fresh hits too
- **Fresh cached errors never expired**: `getWithStale()` now returns errors as `value` for both fresh and stale hits; `callTool()` handles cache outside the upstream try/catch so cached errors are never re-cached with a reset TTL
- **Background refresh data loss**: `touch()` now falls back to INSERT OR IGNORE when the target row was evicted between stale read and refresh
- **Background refresh deduplication**: Multiple concurrent requests for the same stale key no longer fire duplicate upstream calls
- **Per-tool flush left stale adaptive TTL**: `flush(tool)` now also clears `adaptive_ttls` for that tool
- **`set()` inflated per-tool hit count**: `set()` no longer increments `stats_by_tool.hits` — only `get()`/`getWithStale()` do
- **Adaptive TTL adaptor race condition**: `adaptTtls()` now wrapped in a transaction to prevent data loss with concurrent `recordEviction()` calls

### Configuration

New configuration option:

```json
{
  "cache": {
    "staleWhileRevalidateSeconds": 0
  }
}
```

### Testing

- Added 7 new tests for stale-while-revalidate
- Added 4 new tests for cost savings counter
- Added 2 new tests for WAL mode
- Added 4 new tests for eviction tracking
- Added 1 new test for stale-hits-as-misses fix
- Added 7 new tests for adaptive TTL tuning
- Added 2 updated CLI tests for --tune-ttl diagnostic format
- All 126 tests pass (1 unrelated timeout in upstream.test.ts)

## [0.2.0] - 2026-05-01

### Added

- **Negative caching for errors**: Errors are now cached with a separate, shorter TTL to avoid repeated failing API calls
  - Added `negativeCacheTtlSeconds` config option (default: 300 seconds = 5 minutes)
  - Per-server `negativeCacheTtlSeconds` override available
  - Errors are re-thrown as proper Error objects when retrieved from cache
  - Stack traces are sanitized to prevent internal system information exposure

- **Per-entry size limits**: Added `maxEntrySizeBytes` configuration to prevent individual large entries from dominating the cache
  - Default: 10MB per entry
  - Entries exceeding limit are skipped with a warning
  - Applied during both `set()` and `import()` operations

- **Cache export/import**: Added ability to export and import cache contents as JSON
  - `--export <file>` CLI command to export cache to JSON file
  - `--import <file>` CLI command to import cache from JSON file
  - Export includes version, timestamp, and all entry data
  - Import handles existing entries (skips), expired entries (skips), and size limits
  - Preserves original TTL expiration time across imports

- **Per-tool cache statistics**: Enhanced cache statistics with per-tool breakdown
  - `cache_stats()` now returns `byTool` object with hits, misses, hitRate, and sizeBytes per tool
  - Helps identify which tools are most used and which have the most cache misses

- **New CLI modes**: Added `--export` and `--import` commands for cache backup and transfer

### Changed

- **LRU eviction with transactions**: Fixed race condition in eviction logic by wrapping in SQLite transaction
  - Prevents concurrent operations from exceeding cache size limits
  - Ensures atomicity of eviction operations

- **Improved error handling**: Enhanced error serialization and re-throwing
  - Error objects are properly converted to/from JSON
  - Preserves error `message` and `name` properties

### Security

- **Path traversal prevention**: Added path validation to export/import operations
  - Prevents directory traversal attacks via `..` components
  - Validates and normalizes file paths before operations
  - Creates parent directories safely for write operations

- **Stack trace sanitization**: Removed stack traces from exported error entries
  - Prevents exposure of internal file paths, line numbers, and function names
  - Preserves error `message` and `name` for debugging

### Fixed

- **Import TTL calculation**: Fixed bug where imported entries would expire immediately
  - Now correctly preserves original expiration time from export

- **Import size validation**: Added `maxEntrySizeBytes` check during import
  - Previously, large entries could bypass size limits during import

- **Double-encoded JSON**: Fixed export format where `result` field was incorrectly encoded

### Configuration

New configuration options:

```json
{
  "cache": {
    "maxEntrySizeBytes": 10485760,
    "negativeCacheTtlSeconds": 300
  },
  "servers": {
    "example-server": {
      "negativeCacheTtlSeconds": 600
    }
  }
}
```

### Migration

- **Automatic schema migrations**: Database schema is automatically migrated on startup
  - Adds `is_error` column for negative caching
  - Adds `stats_by_tool` table for per-tool statistics
  - Existing databases are seamlessly upgraded

### Testing

- Added 15 new tests for negative caching
- Added 6 new tests for export/import functionality
- Added 5 new tests for per-entry size limits
- Added 7 new CLI tests for export/import
- All 99 tests pass (1 unrelated timeout in upstream.test.ts)

### Documentation

- Updated README with new features and configuration options
- Added export/import usage examples
- Documented new CLI commands

## [0.1.0] - 2024-XX-XX

### Added

- Initial release
- Transparent caching of MCP tool calls
- SQLite-based cache with LRU eviction
- Per-server TTL configuration
- Cache warming support
- Project-specific config overrides
- CLI for cache management (stats, flush, new, warm)
- Support for stdio and HTTP-based MCP servers
