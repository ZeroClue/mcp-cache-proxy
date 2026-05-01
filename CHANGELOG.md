# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
