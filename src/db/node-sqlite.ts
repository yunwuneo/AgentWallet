import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { BetterSQLiteSession } from 'drizzle-orm/better-sqlite3/session';
import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm/relations';
import { BaseSQLiteDatabase, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

// Drizzle 0.45 has no driver for Node's built-in `node:sqlite`, and better-sqlite3's prebuilt
// binaries need glibc >= 2.33 (building from source hangs small servers). So we run drizzle's
// better-sqlite3 session on top of a thin adapter that gives DatabaseSync the handful of
// better-sqlite3 methods that session uses: prepare().run/get/all/raw() and transaction().
// drizzle-orm is pinned to an exact version because this relies on that session's internals.
// Replace with the official `drizzle-orm/node-sqlite` driver once drizzle 1.0 is stable.

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

class Statement {
  private rawStmt?: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    private readonly source: string,
    private readonly stmt: StatementSync = db.prepare(source),
  ) {}

  run(...params: SQLInputValue[]): RunResult {
    return this.stmt.run(...params);
  }

  get(...params: SQLInputValue[]): unknown {
    return this.stmt.get(...params);
  }

  all(...params: SQLInputValue[]): unknown[] {
    return this.stmt.all(...params);
  }

  /** Same statement, returning rows as arrays (better-sqlite3's `raw()` mode). */
  raw(): Pick<StatementSync, 'get' | 'all'> {
    if (!this.rawStmt) {
      this.rawStmt = this.db.prepare(this.source);
      this.rawStmt.setReturnArrays(true);
    }
    return this.rawStmt;
  }
}

type TransactionMode = 'deferred' | 'immediate' | 'exclusive';

/** The subset of better-sqlite3's `Database` API that drizzle's better-sqlite3 session calls. */
export class NodeSqliteClient {
  constructor(readonly db: DatabaseSync) {}

  prepare(source: string): Statement {
    return new Statement(this.db, source);
  }

  /** Like better-sqlite3: returns a function with `.deferred/.immediate/.exclusive` variants. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R) {
    const variant =
      (mode: TransactionMode) =>
      (...args: A): R => {
        this.db.exec(`BEGIN ${mode.toUpperCase()}`);
        try {
          const result = fn(...args);
          this.db.exec('COMMIT');
          return result;
        } catch (err) {
          if (this.db.isTransaction) this.db.exec('ROLLBACK');
          throw err;
        }
      };
    return Object.assign(variant('deferred'), {
      deferred: variant('deferred'),
      immediate: variant('immediate'),
      exclusive: variant('exclusive'),
    });
  }

  close(): void {
    this.db.close();
  }
}

export type NodeSqliteDatabase<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<
  'sync',
  RunResult,
  TSchema
> & { $client: NodeSqliteClient };

/** Equivalent of `drizzle(client, { schema })` from `drizzle-orm/better-sqlite3`, over node:sqlite. */
export function drizzleNodeSqlite<TSchema extends Record<string, unknown>>(
  db: DatabaseSync,
  schema: TSchema,
): NodeSqliteDatabase<TSchema> {
  const client = new NodeSqliteClient(db);
  const dialect = new SQLiteSyncDialect();
  const tables = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  const relational = { fullSchema: schema, schema: tables.tables, tableNamesMap: tables.tableNamesMap };
  // The session is typed against better-sqlite3's Database; NodeSqliteClient implements the part it uses.
  const session = new BetterSQLiteSession(client as never, dialect, relational as never, {});
  const database = new BaseSQLiteDatabase<'sync', RunResult, TSchema>('sync', dialect, session as never, relational as never);
  return Object.assign(database, { $client: client });
}
