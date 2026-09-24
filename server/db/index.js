import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrations } from './migrations.js';

function ensureParent(databasePath) {
  if (databasePath === ':memory:') return;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT
  `);

  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
  const insert = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      migration.up(db);
      insert.run(migration.version, migration.name);
    })();
  }

  const latest = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
  const expected = migrations.at(-1).version;
  if (latest !== expected) throw new Error(`Database schema version ${latest} does not match application version ${expected}`);
  const violations = db.pragma('foreign_key_check');
  if (violations.length) throw new Error(`Database foreign key validation failed (${violations.length} violations)`);
}

export function createDatabase(databasePath, { readonly = false, timeout = 5000 } = {}) {
  ensureParent(databasePath);
  const db = new Database(databasePath, { readonly, timeout, fileMustExist: false });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (databasePath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  if (!readonly) migrate(db);
  return db;
}

export function closeDatabase(db) {
  if (!db?.open) return;
  if (db.memory) {
    db.close();
    return;
  }
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

export function databaseIntegrityCheck(db) {
  return db.pragma('quick_check', { simple: true });
}
