import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncCtor } from 'node:sqlite';
import type { Db, DbStatement, RunResult, SqlParam } from './Db.js';

/**
 * `Db` implemented over Node's built-in SQLite.
 *
 * ── Why this module is loaded through `createRequire` ──────────────────────
 * `node:sqlite` is deliberately absent from `require('node:module').builtinModules`
 * — it is reachable only via the `node:` prefix. Bundlers decide what to leave
 * external by consulting exactly that list, so a plain `import 'node:sqlite'`
 * makes Vite/Rollup try to resolve a package literally named "sqlite", fail,
 * and die with the thoroughly unhelpful `Failed to load url sqlite`.
 *
 * Requiring it at runtime keeps the specifier invisible to static analysis, so
 * the same source works under Vite, Vitest, and the packaged Electron main
 * bundle with no per-bundler configuration. The `import type` above is erased
 * at compile time and costs nothing.
 *
 * This module must only ever be imported from the MAIN process — the renderer
 * has no database access by design.
 */
const nodeRequire = createRequire(import.meta.url);

interface NodeSqliteModule {
  DatabaseSync: typeof DatabaseSyncCtor;
}

function loadSqlite(): NodeSqliteModule {
  return nodeRequire('node:sqlite') as NodeSqliteModule;
}

class SqliteAdapter implements Db {
  #db: InstanceType<typeof DatabaseSyncCtor>;
  /** Depth of nested transaction() calls, so we know when to use SAVEPOINTs. */
  #depth = 0;

  constructor(path: string) {
    const { DatabaseSync } = loadSqlite();
    this.#db = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  pragma(statement: string): void {
    this.#db.exec(`PRAGMA ${statement};`);
  }

  prepare(sql: string): DbStatement {
    const stmt = this.#db.prepare(sql);
    return {
      run: (...params: SqlParam[]): RunResult => {
        const r = stmt.run(...(params as never[]));
        return {
          changes: Number(r.changes),
          lastInsertRowid: Number(r.lastInsertRowid),
        };
      },
      get: <T>(...params: SqlParam[]): T | undefined => {
        const row = stmt.get(...(params as never[]));
        // node:sqlite returns null-prototype objects; normalise them so that
        // ordinary object operations (spread, hasOwnProperty) behave as expected.
        return row === undefined || row === null ? undefined : ({ ...row } as T);
      },
      all: <T>(...params: SqlParam[]): T[] => {
        const rows = stmt.all(...(params as never[]));
        return rows.map((r) => ({ ...r }) as T);
      },
    };
  }

  transaction<T>(fn: () => T): T {
    const nested = this.#depth > 0;
    const name = `sp_${this.#depth}`;

    this.#db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
    this.#depth++;
    try {
      const result = fn();
      this.#depth--;
      this.#db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
      return result;
    } catch (err) {
      this.#depth--;
      // A failure to roll back must not mask the error that caused it.
      try {
        this.#db.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK');
      } catch {
        /* the original error is the one worth propagating */
      }
      throw err;
    }
  }

  close(): void {
    this.#db.close();
  }
}

/** Open (creating if needed) the database at `path`. Pass ':memory:' in tests. */
export function openDatabase(path: string): Db {
  const db = new SqliteAdapter(path);

  // WAL keeps readers from blocking the sync writer; meaningless in-memory.
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  // Without this a concurrent writer fails immediately instead of waiting.
  db.pragma('busy_timeout = 5000');

  return db;
}

/**
 * Probe whether the running Node/Electron actually provides a usable
 * `node:sqlite`. Electron ships its own Node build and the module is still
 * marked experimental, so `doctor` checks this explicitly rather than letting
 * the app fail on its first query.
 */
export function isSqliteAvailable(): { available: boolean; note?: string } {
  try {
    const { DatabaseSync } = loadSqlite();
    const probe = new DatabaseSync(':memory:');
    probe.exec('CREATE TABLE probe (a INTEGER)');
    probe.close();
    return { available: true };
  } catch (err) {
    return {
      available: false,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}
