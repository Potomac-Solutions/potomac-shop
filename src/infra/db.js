// The database: one SQLite file through Node's built-in driver. Only src/infra and src/app touch it;
// the domain never sees a driver.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS = join(here, '..', '..', 'migrations');

/** Open (and create) the database. `:memory:` is for tests. */
export function openDatabase(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

/** Run `work` in one transaction: all of it happens or none of it does. */
export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const checksum = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Apply every numbered migration not yet run, in order, each in its own transaction. A migration
 * that has run is never run again, and one that changed since is an error: add a new one instead.
 */
export function migrate(db, dir = MIGRATIONS) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, sum TEXT NOT NULL, at INTEGER NOT NULL)');
  const done = new Map(db.prepare('SELECT name, sum FROM schema_migrations').all().map((row) => [row.name, row.sum]));
  const applied = [];
  for (const name of readdirSync(dir).filter((file) => /^\d{3}_.+\.sql$/.test(file)).sort()) {
    const sql = readFileSync(join(dir, name), 'utf8');
    const sum = checksum(sql);
    if (done.has(name)) {
      if (done.get(name) !== sum) throw new Error(`Migration ${name} changed after it was applied. Add a new migration instead.`);
      continue;
    }
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, sum, at) VALUES (?, ?, ?)').run(name, sum, Date.now());
    });
    applied.push(name);
  }
  return applied;
}
