import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
    `);
  }

  async get(key: string): Promise<unknown | null> {
    const row = this.db.prepare('SELECT * FROM cache WHERE key = ?').get(key) as CacheEntry | undefined;

    if (!row) return null;

    const now = Math.floor(Date.now() / 1000);
    if (row.ttl_seconds === 0 || now - row.created_at > row.ttl_seconds) {
      this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
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
    // File operations would go here; for in-memory tests, just re-init
    if (dbPath !== ':memory:') {
      throw new Error('Not implemented for file-based DB');
    }
    this.db = new Database(dbPath);
    this.initSchema();
  }

  async getStats(): Promise<CacheStats> {
    const totalRow = this.db.prepare('SELECT COUNT(*) as count FROM cache').get() as { count: number };
    const hitsRow = this.db.prepare('SELECT SUM(hits) as total FROM cache').get() as { total: number | null };
    const missesRow = this.db.prepare('SELECT COUNT(*) as count FROM cache WHERE hits = 0').get() as { count: number };

    const cached = totalRow.count;
    const hits = hitsRow.total || 0;
    const misses = missesRow.count;
    const hitRate = cached > 0 ? hits / (hits + misses) : 0;

    return { cached, hits, hitRate, misses, sizeBytes: 0 };
  }

  close(): void {
    this.db.close();
  }
}
