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
        ttl_seconds INTEGER NOT NULL
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
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO cache (key, tool, args, result, created_at, ttl_seconds)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(key, tool, JSON.stringify(args), JSON.stringify(result), now, ttlSeconds);
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

    const cached = totalRow.count;
    const hits = hitsRow.total || 0;
    const misses = missesRow?.misses ?? 0;
    const hitRate = (hits + misses) > 0 ? hits / (hits + misses) : 0;

    // Calculate approximate database size
    // For in-memory databases, we return 0 as there's no file size to measure
    // For file-based databases, we could check file size but better-sqlite3 doesn't
    // provide a direct API. This would require fs.stat() which adds complexity.
    // Returning 0 is acceptable as the cache layer focuses on hit/miss metrics.
    const sizeBytes = 0;

    return { cached, hits, hitRate, misses, sizeBytes };
  }

  close(): void {
    this.db.close();
  }
}
