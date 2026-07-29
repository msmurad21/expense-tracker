import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import type { Db } from './Db.js';
import { openDatabase } from './sqliteAdapter.js';
import { migrate, getSchemaVersion } from './migrations.js';

export type { Db, DbStatement, RunResult } from './Db.js';
export { openDatabase, isSqliteAvailable } from './sqliteAdapter.js';
export { migrate, getSchemaVersion, MIGRATIONS } from './migrations.js';

const APP_DIR_NAME = 'ExpenseTracker';
const DB_FILE_NAME = 'expense-tracker.db';

/**
 * Where the database lives.
 *
 * Deliberately computed without importing `electron`, so that `npm run doctor`
 * and the test suite — neither of which runs inside Electron — resolve the same
 * path the app uses. Mirrors Electron's `app.getPath('userData')` layout.
 */
export function resolveDataDir(): string {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', APP_DIR_NAME);
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_DIR_NAME);
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), APP_DIR_NAME);
  }
}

export function resolveDatabasePath(): string {
  return join(resolveDataDir(), DB_FILE_NAME);
}

/**
 * Open the database at `path` and bring its schema up to date.
 * Pass ':memory:' in tests.
 */
export function initDatabase(path: string = resolveDatabasePath()): Db {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = openDatabase(path);
  migrate(db);
  return db;
}

/** True if a database file has already been created on disk. */
export function databaseExists(path: string = resolveDatabasePath()): boolean {
  return existsSync(path);
}

/**
 * Read the schema version without running migrations — used by `doctor`, which
 * must report on the database's state rather than change it.
 */
export function inspectSchemaVersion(path: string): number | null {
  if (!existsSync(path)) return null;
  const db = openDatabase(path);
  try {
    return getSchemaVersion(db);
  } finally {
    db.close();
  }
}
