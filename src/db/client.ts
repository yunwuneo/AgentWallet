import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { drizzleNodeSqlite, type NodeSqliteDatabase, type RunResult } from './node-sqlite.js';
import * as schema from './schema.js';

export type Db = NodeSqliteDatabase<typeof schema>;

/** A database or an open transaction on it; services accept either so they can be composed atomically. */
export type DbHandle = BaseSQLiteDatabase<'sync', RunResult, typeof schema>;

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/** Opens (creating if needed) the database at `path` and applies pending migrations. Use ':memory:' for tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const sqlite = new DatabaseSync(path, { timeout: 5000 });
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const db = drizzleNodeSqlite(sqlite, schema);
  // The migrator only uses the session, which works unchanged on the node:sqlite adapter.
  migrate(db as never, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}
