import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

interface CacheEntry {
  key: string;
  tool: string;
  args: string;
  result: string;
  created_at: number;
  hits: number;
  ttl_seconds: number;
  size_bytes: number;
}

interface CacheStats {
  cached: number;
  hits: number;
  hitRate: number;
  misses: number;
  sizeBytes: number;
}

export class CacheStore {
  private db: Database.Database;
  private config: { path: string; maxSizeBytes: number; defaultTtlSeconds: number };

  constructor(config: { path: string; maxSizeBytes: number; defaultTtlSeconds: number }) {
    this.config = config;
    const dbPath = config.path.startsWith('~') ? join(homedir(), config.path.slice(1)) : config.path;
    this.db = new Database(dbPath);
    this.initSchema();
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
        size_bytes INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cache_tool ON cache(tool);
      CREATE INDEX IF NOT EXISTS idx_cache_created ON cache(created_at);

      CREATE TABLE IF NOT EXISTS stats (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        misses INTEGER DEFAULT 0
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
  }

  async get(key: string): Promise<unknown | null> {
    const row = this.db.prepare('SELECT * FROM cache WHERE key = ?').get(key) as CacheEntry | undefined;

    if (!row) {
      // Track cache miss
      this.db.prepare('UPDATE stats SET misses = misses + 1 WHERE id = 1').run();
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (row.ttl_seconds === 0 || now - row.created_at > row.ttl_seconds) {
      this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
      // Expired entry is also a miss
      this.db.prepare('UPDATE stats SET misses = misses + 1 WHERE id = 1').run();
      return null;
    }

    this.db.prepare('UPDATE cache SET hits = hits + 1 WHERE key = ?').run(key);
    return JSON.parse(row.result);
  }

  async set(key: string, tool: string, args: unknown, result: unknown, ttlSeconds: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const argsJson = JSON.stringify(args);
    const resultJson = JSON.stringify(result);
    const entrySize = Buffer.byteLength(argsJson, 'utf8') + Buffer.byteLength(resultJson, 'utf8');

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO cache (key, tool, args, result, created_at, ttl_seconds, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(key, tool, argsJson, resultJson, now, ttlSeconds, entrySize);

    // Check if cache size exceeds maximum and evict if necessary
    await this.evictIfNeeded();
  }

  private async evictIfNeeded(): Promise<void> {
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
      // Get the size of entries we're about to delete
      const candidateStmt = this.db.prepare(`
        SELECT key, size_bytes FROM cache
        ORDER BY hits ASC, created_at ASC
        LIMIT 100
      `);
      const candidates = candidateStmt.all() as Array<{ key: string; size_bytes: number }>;

      if (candidates.length === 0) {
        break; // No more entries to delete
      }

      const keysToDelete = candidates.map(c => c.key);
      const sizeToDelete = candidates.reduce((sum, c) => sum + c.size_bytes, 0);

      // Delete the batch
      this.db.prepare(`
        DELETE FROM cache WHERE key IN (${keysToDelete.map(() => '?').join(',')})
      `).run(...keysToDelete);

      remainingSize -= sizeToDelete;
    }
  }

  async flush(tool?: string): Promise<void> {
    if (tool) {
      this.db.prepare('DELETE FROM cache WHERE tool = ?').run(tool);
    } else {
      this.db.prepare('DELETE FROM cache').run();
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
    const missesRow = this.db.prepare('SELECT misses FROM stats WHERE id = 1').get() as { misses: number } | undefined;
    const sizeRow = this.db.prepare('SELECT SUM(size_bytes) as total FROM cache').get() as { total: number | null };

    const cached = totalRow.count;
    const hits = hitsRow.total || 0;
    const misses = missesRow?.misses ?? 0;
    const hitRate = (hits + misses) > 0 ? hits / (hits + misses) : 0;
    const sizeBytes = sizeRow?.total ?? 0;

    return { cached, hits, hitRate, misses, sizeBytes };
  }

  close(): void {
    this.db.close();
  }
}
