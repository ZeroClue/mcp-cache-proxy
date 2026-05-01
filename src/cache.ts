import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join, resolve, normalize, dirname } from 'node:path';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';

interface CacheEntry {
  key: string;
  tool: string;
  args: string;
  result: string;
  created_at: number;
  hits: number;
  ttl_seconds: number;
  size_bytes: number;
  is_error: number; // 0 or 1
}

interface CacheGetResult {
  value: unknown;
  stale: boolean; // true if entry is past TTL but within stale grace period
}

interface CacheStats {
  cached: number;
  hits: number;
  hitRate: number;
  misses: number;
  sizeBytes: number;
  staleHits: number;
  savedCalls: number;
  byTool: Record<string, ToolStats>;
}

interface ToolStats {
  hits: number;
  misses: number;
  hitRate: number;
  sizeBytes: number;
}

export class CacheStore {
  private db: Database.Database;
  private config: { path: string; maxSizeBytes: number; maxEntrySizeBytes?: number; defaultTtlSeconds: number; negativeCacheTtlSeconds?: number; staleWhileRevalidateSeconds?: number };

  constructor(config: { path: string; maxSizeBytes: number; maxEntrySizeBytes?: number; defaultTtlSeconds: number; negativeCacheTtlSeconds?: number; staleWhileRevalidateSeconds?: number }) {
    this.config = config;
    const dbPath = config.path.startsWith('~') ? join(homedir(), config.path.slice(1)) : config.path;
    this.db = new Database(dbPath);
    // Enable WAL mode for concurrent read performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
  }

  private validateFilePath(filePath: string, write: boolean = false): string {
    const resolved = resolve(filePath);
    const normalized = normalize(resolved);

    // Prevent directory traversal attacks
    const parts = normalized.split('/');
    for (const part of parts) {
      if (part === '..') {
        throw new Error('Invalid file path: path traversal detected');
      }
    }

    // For write operations, ensure parent directory exists
    if (write) {
      const dir = dirname(normalized);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    return normalized;
  }

  private sanitizeResult(result: string, isError: boolean): string {
    if (isError) {
      try {
        const parsed = JSON.parse(result) as { message?: string; name?: string; stack?: string };
        // Remove stack trace to prevent internal system information exposure
        delete parsed.stack;
        return JSON.stringify(parsed);
      } catch {
        // If parsing fails, return original
        return result;
      }
    }
    return result;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        args TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        hits INTEGER DEFAULT 0,
        ttl_seconds INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        is_error INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cache_tool ON cache(tool);
      CREATE INDEX IF NOT EXISTS idx_cache_created ON cache(created_at);

      CREATE TABLE IF NOT EXISTS stats (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        misses INTEGER DEFAULT 0,
        stale_hits INTEGER DEFAULT 0,
        saved_calls INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS stats_by_tool (
        tool TEXT PRIMARY KEY,
        hits INTEGER DEFAULT 0,
        misses INTEGER DEFAULT 0,
        size_bytes INTEGER DEFAULT 0
      );
    `);

    // Initialize stats row using INSERT OR IGNORE
    this.db.prepare('INSERT OR IGNORE INTO stats (id, misses) VALUES (1, 0)').run();

    // Migration: Add size_bytes column if it doesn't exist (for existing databases)
    try {
      const columns = this.db.prepare("PRAGMA table_info(cache)").all() as Array<{ name: string }>;
      const hasSizeBytes = columns.some(col => col.name === 'size_bytes');
      if (!hasSizeBytes) {
        this.db.exec('ALTER TABLE cache ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0');
        // Recalculate sizes for existing entries
        this.db.prepare(`
          UPDATE cache SET size_bytes = LENGTH(args) + LENGTH(result)
        `).run();
      }
    } catch (error) {
      // Column might already exist or other schema issue
      console.warn('Schema migration check failed:', error);
    }

    // Migration: Add stats_by_tool table if it doesn't exist (for existing databases)
    try {
      const tableExists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stats_by_tool'").get() as { name: string } | undefined;
      if (!tableExists) {
        // Create table and backfill data from existing cache entries
        this.db.exec(`
          CREATE TABLE stats_by_tool (
            tool TEXT PRIMARY KEY,
            hits INTEGER DEFAULT 0,
            misses INTEGER DEFAULT 0,
            size_bytes INTEGER DEFAULT 0
          );
        `);
        // Backfill: aggregate existing cache data by tool
        this.db.exec(`
          INSERT INTO stats_by_tool (tool, hits, size_bytes)
          SELECT tool, SUM(hits), SUM(size_bytes)
          FROM cache
          GROUP BY tool
        `);
      }
    } catch (error) {
      console.warn('Stats by tool migration check failed:', error);
    }

    // Migration: Add is_error column if it doesn't exist (for existing databases)
    try {
      const columns = this.db.prepare("PRAGMA table_info(cache)").all() as Array<{ name: string }>;
      const hasIsError = columns.some(col => col.name === 'is_error');
      if (!hasIsError) {
        this.db.exec('ALTER TABLE cache ADD COLUMN is_error INTEGER NOT NULL DEFAULT 0');
      }
    } catch (error) {
      console.warn('is_error migration check failed:', error);
    }

    // Migration: Add stale_hits column to stats if it doesn't exist
    try {
      const statsColumns = this.db.prepare("PRAGMA table_info(stats)").all() as Array<{ name: string }>;
      const hasStaleHits = statsColumns.some(col => col.name === 'stale_hits');
      if (!hasStaleHits) {
        this.db.exec('ALTER TABLE stats ADD COLUMN stale_hits INTEGER DEFAULT 0');
      }
    } catch (error) {
      console.warn('stale_hits migration check failed:', error);
    }

    // Migration: Add saved_calls column to stats if it doesn't exist
    try {
      const statsColumns2 = this.db.prepare("PRAGMA table_info(stats)").all() as Array<{ name: string }>;
      const hasSavedCalls = statsColumns2.some(col => col.name === 'saved_calls');
      if (!hasSavedCalls) {
        this.db.exec('ALTER TABLE stats ADD COLUMN saved_calls INTEGER DEFAULT 0');
        // Backfill: sum of all hits so far = saved calls
        this.db.exec('UPDATE stats SET saved_calls = (SELECT COALESCE(SUM(hits), 0) FROM cache) WHERE id = 1');
      }
    } catch (error) {
      console.warn('saved_calls migration check failed:', error);
    }

    // New tables for adaptive TTL tuning
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS eviction_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool TEXT NOT NULL,
        evicted_at INTEGER NOT NULL,
        had_hits INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        eviction_reason TEXT NOT NULL DEFAULT 'expired'
      );
      CREATE INDEX IF NOT EXISTS idx_eviction_stats_tool ON eviction_stats(tool);
      CREATE INDEX IF NOT EXISTS idx_eviction_stats_evicted_at ON eviction_stats(evicted_at);
      CREATE TABLE IF NOT EXISTS adaptive_ttls (
        tool TEXT PRIMARY KEY,
        effective_ttl INTEGER NOT NULL,
        base_ttl INTEGER NOT NULL,
        last_adjusted_at INTEGER NOT NULL,
        adjustment_count INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  async get(key: string, toolName?: string): Promise<unknown | null> {
    const row = this.db.prepare('SELECT * FROM cache WHERE key = ?').get(key) as CacheEntry | undefined;

    if (!row) {
      // Track cache miss (global)
      this.db.prepare('UPDATE stats SET misses = misses + 1 WHERE id = 1').run();
      // Track cache miss (per-tool) - we need to know the tool, but on cache miss we don't have it from the row
      // The toolName parameter allows the caller to provide this info
      if (toolName) {
        this.db.prepare(`
          INSERT INTO stats_by_tool (tool, misses) VALUES (?, 1)
          ON CONFLICT(tool) DO UPDATE SET misses = misses + 1
        `).run(toolName);
      }
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (row.ttl_seconds === 0 || now - row.created_at > row.ttl_seconds) {
      this.recordEviction(row.tool, row.hits > 0, row.size_bytes, 'expired');
      this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
      // Expired entry is also a miss
      this.db.prepare('UPDATE stats SET misses = misses + 1 WHERE id = 1').run();
      // Track miss for the tool
      this.db.prepare(`
        INSERT INTO stats_by_tool (tool, misses) VALUES (?, 1)
        ON CONFLICT(tool) DO UPDATE SET misses = misses + 1
      `).run(row.tool);
      return null;
    }

    this.db.prepare('UPDATE cache SET hits = hits + 1 WHERE key = ?').run(key);
    this.db.prepare('UPDATE stats SET saved_calls = saved_calls + 1 WHERE id = 1').run();
    const parsed = JSON.parse(row.result);

    // If this is a cached error, re-throw it as an Error object
    if (row.is_error === 1) {
      const error = parsed as { message?: string; name?: string };
      const err = new Error(error.message || 'Unknown error');
      if (error.name) err.name = error.name;
      throw err;
    }

    return parsed;
  }

  async getWithStale(key: string, toolName?: string): Promise<CacheGetResult | null> {
    const row = this.db.prepare('SELECT * FROM cache WHERE key = ?').get(key) as CacheEntry | undefined;

    if (!row) {
      this.db.prepare('UPDATE stats SET misses = misses + 1 WHERE id = 1').run();
      if (toolName) {
        this.db.prepare(`
          INSERT INTO stats_by_tool (tool, misses) VALUES (?, 1)
          ON CONFLICT(tool) DO UPDATE SET misses = misses + 1
        `).run(toolName);
      }
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    const age = now - row.created_at;

    // Expired beyond stale grace period — delete and miss
    const staleGrace = this.config.staleWhileRevalidateSeconds ?? 0;
    if (age > row.ttl_seconds + staleGrace) {
      this.recordEviction(row.tool, row.hits > 0, row.size_bytes, 'stale_expired');
      this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
      this.db.prepare('UPDATE stats SET misses = misses + 1 WHERE id = 1').run();
      this.db.prepare(`
        INSERT INTO stats_by_tool (tool, misses) VALUES (?, 1)
        ON CONFLICT(tool) DO UPDATE SET misses = misses + 1
      `).run(row.tool);
      return null;
    }

    // Stale but within grace period — return stale data
    if (age > row.ttl_seconds) {
      this.db.prepare('UPDATE cache SET hits = hits + 1 WHERE key = ?').run(key);
      this.db.prepare('UPDATE stats SET stale_hits = stale_hits + 1, saved_calls = saved_calls + 1 WHERE id = 1').run();
      // Track stale hit per-tool
      this.db.prepare(`
        INSERT INTO stats_by_tool (tool, hits) VALUES (?, 1)
        ON CONFLICT(tool) DO UPDATE SET hits = hits + 1
      `).run(row.tool);
      const parsed = JSON.parse(row.result);
      if (row.is_error === 1) {
        // Return stale error as value so caller can still serve stale data and refresh in background
        const error = parsed as { message?: string; name?: string };
        const err = new Error(error.message || 'Unknown error');
        if (error.name) err.name = error.name;
        return { value: err, stale: true };
      }
      return { value: parsed, stale: true };
    }

    // Fresh cache hit
    this.db.prepare('UPDATE cache SET hits = hits + 1 WHERE key = ?').run(key);
    this.db.prepare('UPDATE stats SET saved_calls = saved_calls + 1 WHERE id = 1').run();
    this.db.prepare(`
      INSERT INTO stats_by_tool (tool, hits) VALUES (?, 1)
      ON CONFLICT(tool) DO UPDATE SET hits = hits + 1
    `).run(row.tool);
    const parsed = JSON.parse(row.result);
    if (row.is_error === 1) {
      const error = parsed as { message?: string; name?: string };
      const err = new Error(error.message || 'Unknown error');
      if (error.name) err.name = error.name;
      return { value: err, stale: false };
    }
    return { value: parsed, stale: false };
  }

  async touch(key: string, tool: string, args: unknown, result: unknown, ttlSeconds: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const resultJson = JSON.stringify(result);
    const argsJson = JSON.stringify(args);
    const entrySize = Buffer.byteLength(argsJson, 'utf8') + Buffer.byteLength(resultJson, 'utf8');

    if (this.config.maxEntrySizeBytes !== undefined && entrySize > this.config.maxEntrySizeBytes) {
      return;
    }

    const updateStmt = this.db.prepare(`
      UPDATE cache SET result = ?, args = ?, created_at = ?, ttl_seconds = ?, size_bytes = ?, is_error = 0
      WHERE key = ?
    `);
    const updateResult = updateStmt.run(resultJson, argsJson, now, ttlSeconds, entrySize, key);

    // If the row was evicted between getWithStale and touch, re-insert
    if (updateResult.changes === 0) {
      this.db.prepare(`
        INSERT OR IGNORE INTO cache (key, tool, args, result, created_at, ttl_seconds, size_bytes, is_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(key, tool, argsJson, resultJson, now, ttlSeconds, entrySize);
    }
  }

  async set(key: string, tool: string, args: unknown, result: unknown, ttlSeconds: number, isError: boolean = false): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const argsJson = JSON.stringify(args);

    // Convert Error objects to plain objects for serialization
    let resultJson: string;
    if (isError && result instanceof Error) {
      // Extract Error properties for serialization
      const errorObj = {
        message: result.message,
        name: result.name,
        stack: result.stack
      };
      resultJson = JSON.stringify(errorObj);
    } else {
      resultJson = JSON.stringify(result);
    }

    const entrySize = Buffer.byteLength(argsJson, 'utf8') + Buffer.byteLength(resultJson, 'utf8');

    // Check if entry exceeds max entry size limit
    if (this.config.maxEntrySizeBytes !== undefined && entrySize > this.config.maxEntrySizeBytes) {
      console.warn(`[CACHE] Entry size (${entrySize} bytes) exceeds maxEntrySizeBytes (${this.config.maxEntrySizeBytes} bytes), skipping cache for tool=${tool}`);
      return; // Don't cache entries that are too large
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO cache (key, tool, args, result, created_at, ttl_seconds, size_bytes, is_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(key, tool, argsJson, resultJson, now, ttlSeconds, entrySize, isError ? 1 : 0);

    // Update per-tool stats for the new entry
    this.db.prepare(`
      INSERT INTO stats_by_tool (tool, hits, size_bytes)
      VALUES (?, 0, ?)
      ON CONFLICT(tool) DO UPDATE SET
        size_bytes = size_bytes + ?
    `).run(tool, entrySize, entrySize);

    // Check if cache size exceeds maximum and evict if necessary
    await this.evictIfNeeded();
  }

  private async evictIfNeeded(): Promise<void> {
    // Use transaction to prevent race conditions during concurrent operations
    const transaction = this.db.transaction(() => {
      // Calculate current total cache size
      const sizeRow = this.db.prepare('SELECT SUM(size_bytes) as total FROM cache').get() as { total: number | null };
      const currentSize = sizeRow?.total ?? 0;

      if (currentSize <= this.config.maxSizeBytes) {
        return; // No eviction needed
      }

      // Delete entries with lowest (hits, created_at) tuple until under limit
      const targetSize = this.config.maxSizeBytes * 0.9; // Evict to 90% of max to avoid frequent evictions
      let remainingSize = currentSize;

      // Delete entries in batches until we're under the target size
      while (remainingSize > targetSize) {
        // Get entries to delete with their tool and size
        const candidateStmt = this.db.prepare(`
          SELECT key, tool, size_bytes, hits FROM cache
          ORDER BY hits ASC, created_at ASC
          LIMIT 100
        `);
        const candidates = candidateStmt.all() as Array<{ key: string; tool: string; size_bytes: number; hits: number }>;

        if (candidates.length === 0) {
          break; // No more entries to delete
        }

        const keysToDelete = candidates.map(c => c.key);
        const sizeToDelete = candidates.reduce((sum, c) => sum + c.size_bytes, 0);

        // Record evictions and update per-tool stats
        for (const candidate of candidates) {
          this.recordEviction(candidate.tool, candidate.hits > 0, candidate.size_bytes, 'lru');
          this.db.prepare(`
            INSERT INTO stats_by_tool (tool, size_bytes)
            VALUES (?, ?)
            ON CONFLICT(tool) DO UPDATE SET size_bytes = size_bytes - ?
          `).run(candidate.tool, candidate.size_bytes, candidate.size_bytes);
        }

        // Delete the batch
        this.db.prepare(`
          DELETE FROM cache WHERE key IN (${keysToDelete.map(() => '?').join(',')})
        `).run(...keysToDelete);

        remainingSize -= sizeToDelete;
      }
    });

    transaction();
  }

  async flush(tool?: string): Promise<void> {
    if (tool) {
      this.db.prepare('DELETE FROM cache WHERE tool = ?').run(tool);
      this.db.prepare('DELETE FROM stats_by_tool WHERE tool = ?').run(tool);
      this.db.prepare('DELETE FROM eviction_stats WHERE tool = ?').run(tool);
      this.db.prepare('DELETE FROM adaptive_ttls WHERE tool = ?').run(tool);
    } else {
      this.db.prepare('DELETE FROM cache').run();
      this.db.prepare('DELETE FROM stats_by_tool').run();
      this.db.prepare('DELETE FROM eviction_stats').run();
      this.db.prepare('DELETE FROM adaptive_ttls').run();
      this.db.prepare('UPDATE stats SET misses = 0, stale_hits = 0, saved_calls = 0 WHERE id = 1').run();
    }
  }

  async recreate(): Promise<void> {
    this.db.close();
    const dbPath = this.config.path.startsWith('~') ? join(homedir(), this.config.path.slice(1)) : this.config.path;

    // Delete the database file if it exists (for file-based databases)
    if (dbPath !== ':memory:' && existsSync(dbPath)) {
      try {
        unlinkSync(dbPath);
      } catch (error) {
        // Log warning but continue if deletion fails
        console.warn(`Failed to delete database file at ${dbPath}:`, error);
      }
    }

    // Create a new database instance
    this.db = new Database(dbPath);
    this.initSchema();
  }

  async getStats(): Promise<CacheStats> {
    const totalRow = this.db.prepare('SELECT COUNT(*) as count FROM cache').get() as { count: number };
    const hitsRow = this.db.prepare('SELECT SUM(hits) as total FROM cache').get() as { total: number | null };
    const missesRow = this.db.prepare('SELECT misses, stale_hits, saved_calls FROM stats WHERE id = 1').get() as { misses: number; stale_hits: number; saved_calls: number } | undefined;
    const sizeRow = this.db.prepare('SELECT SUM(size_bytes) as total FROM cache').get() as { total: number | null };

    const cached = totalRow.count;
    const hits = hitsRow.total || 0;
    const misses = missesRow?.misses ?? 0;
    const hitRate = (hits + misses) > 0 ? hits / (hits + misses) : 0;
    const sizeBytes = sizeRow?.total ?? 0;

    // Get per-tool breakdown
    const byToolRows = this.db.prepare('SELECT * FROM stats_by_tool').all() as Array<{
      tool: string;
      hits: number;
      misses: number;
      size_bytes: number;
    }>;

    const byTool: Record<string, ToolStats> = {};
    for (const row of byToolRows) {
      const toolHits = row.hits;
      const toolMisses = row.misses;
      const toolHitRate = (toolHits + toolMisses) > 0 ? toolHits / (toolHits + toolMisses) : 0;
      byTool[row.tool] = {
        hits: toolHits,
        misses: toolMisses,
        hitRate: toolHitRate,
        sizeBytes: row.size_bytes
      };
    }

    return { cached, hits, hitRate, misses, sizeBytes, staleHits: missesRow?.stale_hits ?? 0, savedCalls: missesRow?.saved_calls ?? 0, byTool };
  }

  async exportCache(filePath: string): Promise<void> {
    const validatedPath = this.validateFilePath(filePath, true);

    const rows = this.db.prepare('SELECT key, tool, args, result, created_at, ttl_seconds, is_error FROM cache').all() as Array<{
      key: string;
      tool: string;
      args: string;
      result: string;
      created_at: number;
      ttl_seconds: number;
      is_error: number;
    }>;

    const exportData = {
      version: 1,
      exportedAt: Math.floor(Date.now() / 1000),
      entries: rows.map(row => ({
        key: row.key,
        tool: row.tool,
        args: JSON.parse(row.args),
        result: JSON.parse(this.sanitizeResult(row.result, row.is_error === 1)),
        created_at: row.created_at,
        ttl_seconds: row.ttl_seconds,
        is_error: row.is_error === 1
      }))
    };

    await import('node:fs/promises').then(fs => fs.writeFile(validatedPath, JSON.stringify(exportData, null, 2), 'utf-8'));
  }

  async importCache(filePath: string): Promise<{ imported: number; skipped: number }> {
    const validatedPath = this.validateFilePath(filePath, false);
    const content = await import('node:fs/promises').then(fs => fs.readFile(validatedPath, 'utf-8'));
    const data = JSON.parse(content) as { version: number; entries: Array<{ key: string; tool: string; args: unknown; result: unknown; created_at: number; ttl_seconds: number; is_error: boolean }> };

    let imported = 0;
    let skipped = 0;

    const now = Math.floor(Date.now() / 1000);

    for (const entry of data.entries) {
      // Check if entry already exists
      const existing = this.db.prepare('SELECT key FROM cache WHERE key = ?').get(entry.key) as { key: string } | undefined;

      if (existing) {
        skipped++;
        continue;
      }

      // Calculate TTL expiration
      const age = now - entry.created_at;
      if (age >= entry.ttl_seconds) {
        // Entry already expired, skip
        skipped++;
        continue;
      }

      // Calculate remaining TTL from original expiration time
      const remainingTtl = entry.ttl_seconds - age;
      if (remainingTtl <= 0) {
        // Entry would expire immediately, skip
        skipped++;
        continue;
      }

      const argsJson = JSON.stringify(entry.args);
      const resultJson = JSON.stringify(entry.result);
      const entrySize = Buffer.byteLength(argsJson, 'utf8') + Buffer.byteLength(resultJson, 'utf8');

      // Check if entry exceeds max entry size limit
      if (this.config.maxEntrySizeBytes !== undefined && entrySize > this.config.maxEntrySizeBytes) {
        console.warn(`[CACHE] Skipping import of oversized entry (${entrySize} bytes > ${this.config.maxEntrySizeBytes} bytes) for key=${entry.key}`);
        skipped++;
        continue;
      }

      this.db.prepare(`
        INSERT INTO cache (key, tool, args, result, created_at, ttl_seconds, size_bytes, is_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(entry.key, entry.tool, argsJson, resultJson, now, remainingTtl, entrySize, entry.is_error ? 1 : 0);

      // Update per-tool stats
      this.db.prepare(`
        INSERT INTO stats_by_tool (tool, hits, size_bytes)
        VALUES (?, 1, ?)
        ON CONFLICT(tool) DO UPDATE SET
          hits = hits + 1,
          size_bytes = size_bytes + ?
      `).run(entry.tool, entrySize, entrySize);

      imported++;
    }

    return { imported, skipped };
  }

  private recordEviction(tool: string, hadHits: boolean, sizeBytes: number, reason: 'expired' | 'stale_expired' | 'lru'): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO eviction_stats (tool, evicted_at, had_hits, size_bytes, eviction_reason)
      VALUES (?, ?, ?, ?, ?)
    `).run(tool, now, hadHits ? 1 : 0, sizeBytes, reason);
  }

  initAdaptiveTtls(servers: Record<string, { cacheTtlSeconds?: number; adaptiveTtl?: boolean }>, toolToServer: Map<string, string>): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [serverName, cfg] of Object.entries(servers)) {
      if (!cfg.adaptiveTtl) continue;
      const baseTtl = cfg.cacheTtlSeconds ?? 43200;
      for (const [toolName, srv] of toolToServer) {
        if (srv !== serverName) continue;
        this.db.prepare(`
          INSERT INTO adaptive_ttls (tool, effective_ttl, base_ttl, last_adjusted_at, adjustment_count)
          VALUES (?, ?, ?, ?, 0)
          ON CONFLICT(tool) DO UPDATE SET base_ttl = excluded.base_ttl
        `).run(toolName, baseTtl, baseTtl, now);
      }
    }
  }

  getAdaptiveTtl(toolName: string): number | null {
    const row = this.db.prepare('SELECT effective_ttl FROM adaptive_ttls WHERE tool = ?').get(toolName) as { effective_ttl: number } | undefined;
    return row?.effective_ttl ?? null;
  }

  getAdaptiveTtlStatus(): Array<{
    tool: string;
    baseTtl: number;
    effectiveTtl: number;
    lastAdjustedAt: number;
    adjustmentCount: number;
    evictionsLastHour: number;
    prematureEvictionsLastHour: number;
    prematureRate: number;
  }> {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const rows = this.db.prepare(`
      SELECT
        a.tool,
        a.base_ttl as baseTtl,
        a.effective_ttl as effectiveTtl,
        a.last_adjusted_at as lastAdjustedAt,
        a.adjustment_count as adjustmentCount,
        COALESCE(e.total, 0) as evictionsLastHour,
        COALESCE(e.premature, 0) as prematureEvictionsLastHour
      FROM adaptive_ttls a
      LEFT JOIN (
        SELECT tool, COUNT(*) as total, SUM(CASE WHEN had_hits = 0 THEN 1 ELSE 0 END) as premature
        FROM eviction_stats WHERE evicted_at > ? GROUP BY tool
      ) e ON a.tool = e.tool
      ORDER BY a.tool
    `).all(oneHourAgo) as Array<{
      tool: string;
      baseTtl: number;
      effectiveTtl: number;
      lastAdjustedAt: number;
      adjustmentCount: number;
      evictionsLastHour: number;
      prematureEvictionsLastHour: number;
    }>;
    return rows.map(row => ({
      ...row,
      prematureRate: row.evictionsLastHour > 0 ? row.prematureEvictionsLastHour / row.evictionsLastHour : 0
    }));
  }

  async adaptTtls(servers: Record<string, { cacheTtlRange?: { min: number; max: number } }>, toolToServer: Map<string, string>): Promise<void> {
    const transaction = this.db.transaction(() => {
      const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
      const rows = this.db.prepare(`
        SELECT tool, COUNT(*) as total_evictions,
          SUM(CASE WHEN had_hits = 0 THEN 1 ELSE 0 END) as premature_evictions
        FROM eviction_stats
        WHERE evicted_at > ?
        GROUP BY tool
        HAVING COUNT(*) >= 5
      `).all(oneHourAgo) as Array<{ tool: string; total_evictions: number; premature_evictions: number }>;

      const now = Math.floor(Date.now() / 1000);
      for (const row of rows) {
        const currentRow = this.db.prepare('SELECT effective_ttl, base_ttl FROM adaptive_ttls WHERE tool = ?').get(row.tool) as { effective_ttl: number; base_ttl: number } | undefined;
        if (!currentRow) continue;

        const prematureRate = row.premature_evictions / row.total_evictions;
        let newTtl = currentRow.effective_ttl;

        if (prematureRate > 0.6) {
          newTtl = Math.round(currentRow.effective_ttl * 0.85);
        } else if (prematureRate < 0.2) {
          newTtl = Math.round(currentRow.effective_ttl * 1.2);
        }

        const serverName = toolToServer.get(row.tool);
        const serverCfg = serverName ? servers[serverName] : undefined;
        const minTtl = serverCfg?.cacheTtlRange?.min ?? Math.max(300, Math.round(currentRow.base_ttl * 0.1));
        const maxTtl = serverCfg?.cacheTtlRange?.max ?? Math.min(604800, Math.round(currentRow.base_ttl * 10));
        newTtl = Math.max(minTtl, Math.min(maxTtl, newTtl));

        if (newTtl !== currentRow.effective_ttl) {
          this.db.prepare(`
            INSERT INTO adaptive_ttls (tool, effective_ttl, base_ttl, last_adjusted_at, adjustment_count)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(tool) DO UPDATE SET effective_ttl = ?, last_adjusted_at = ?, adjustment_count = adjustment_count + 1
          `).run(row.tool, newTtl, currentRow.base_ttl, now, newTtl, now);
        }
      }

      // Cleanup old eviction stats
      this.db.prepare('DELETE FROM eviction_stats WHERE evicted_at < ?').run(Math.floor(Date.now() / 1000) - 86400);
    });
    transaction();
  }

  close(): void {
    this.db.close();
  }
}
