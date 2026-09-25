import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  emptyState,
  type CreateDashboardItem,
  type DashboardItem,
  type DashboardState,
  type PatchDashboardItem,
  type ScreenDocument,
  screenDocumentSchema,
} from '@even-agent/protocol';

export class ItemStore {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly now = Date.now,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER);
      CREATE INDEX IF NOT EXISTS items_expiry ON items(expires_at);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES ('updatedAt', 0);
      CREATE TABLE IF NOT EXISTS screen (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db
        .prepare(
          "UPDATE metadata SET value = MAX(value + 1, ?) WHERE key = 'updatedAt'",
        )
        .run(this.now());
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  create(input: CreateDashboardItem): DashboardItem {
    const item = { ...input, id: randomUUID(), createdAt: this.now() };
    return this.transaction(() => {
      this.db
        .prepare('INSERT INTO items VALUES (?, ?, ?)')
        .run(item.id, JSON.stringify(item), item.expiresAt ?? null);
      return item;
    });
  }
  patch(id: string, patch: PatchDashboardItem): DashboardItem | undefined {
    const row = this.db.prepare('SELECT data FROM items WHERE id = ?').get(id);
    if (!row) return;
    const item = { ...JSON.parse(String(row.data)), ...patch } as DashboardItem;
    for (const key of ['description', 'expiresAt', 'actions'] as const) {
      if (patch[key] === null) delete item[key];
    }
    return this.transaction(() => {
      this.db
        .prepare('UPDATE items SET data = ?, expires_at = ? WHERE id = ?')
        .run(JSON.stringify(item), item.expiresAt ?? null, id);
      return item;
    });
  }
  delete(id: string): boolean {
    if (!this.db.prepare('SELECT id FROM items WHERE id = ?').get(id))
      return false;
    return this.transaction(() => {
      this.db.prepare('DELETE FROM items WHERE id = ?').run(id);
      return true;
    });
  }
  expire(): boolean {
    const now = this.now();
    if (
      !this.db
        .prepare('SELECT id FROM items WHERE expires_at <= ? LIMIT 1')
        .get(now)
    )
      return false;
    return this.transaction(() => {
      this.db.prepare('DELETE FROM items WHERE expires_at <= ?').run(now);
      return true;
    });
  }
  state(): DashboardState {
    const state = emptyState();
    state.updatedAt = Number(
      this.db
        .prepare("SELECT value FROM metadata WHERE key = 'updatedAt'")
        .get()!.value,
    );
    const items = this.db
      .prepare(
        'SELECT data FROM items WHERE expires_at IS NULL OR expires_at > ?',
      )
      .all(this.now())
      .map((row) => JSON.parse(String(row.data)) as DashboardItem);
    const ranks = { high: 0, normal: 1, low: 2 };
    items.sort(
      (a, b) =>
        ranks[a.priority] - ranks[b.priority] ||
        b.createdAt - a.createdAt ||
        a.id.localeCompare(b.id),
    );
    for (const item of items) state[item.section].push(item);
    return state;
  }
  screen(): { document: ScreenDocument; updatedAt: number } | undefined {
    const row = this.db
      .prepare('SELECT data,updated_at FROM screen WHERE id=1')
      .get();
    return row
      ? {
          document: screenDocumentSchema.parse(JSON.parse(String(row.data))),
          updatedAt: Number(row.updated_at),
        }
      : undefined;
  }
  setScreen(document: ScreenDocument) {
    const updatedAt = Math.max(this.now(), (this.screen()?.updatedAt ?? 0) + 1);
    this.db
      .prepare(
        'INSERT INTO screen VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
      )
      .run(JSON.stringify(document), updatedAt);
    return { document, updatedAt };
  }
  clearScreen() {
    this.db.prepare('DELETE FROM screen WHERE id=1').run();
  }
  close() {
    this.db.close();
  }
}
