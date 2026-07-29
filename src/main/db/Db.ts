/**
 * A minimal database port.
 *
 * Why this exists: we deliberately depend on `node:sqlite` (built into Node and
 * therefore into Electron) rather than `better-sqlite3`. better-sqlite3 links
 * against V8 directly, so whenever a prebuilt binary does not match it compiles
 * from source — which needs Xcode Command Line Tools on macOS and Visual Studio
 * Build Tools on Windows. This project's whole premise is that a non-technical
 * user can clone it and have an agent set it up, and "please install a 7 GB C++
 * toolchain" kills that at step one.
 *
 * The trade-off is that `node:sqlite` is still marked experimental, so we keep
 * the surface we depend on tiny and behind this interface. Swapping in
 * better-sqlite3 or libsql later means writing one adapter, not touching call
 * sites — all three share essentially this shape.
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface DbStatement {
  run(...params: SqlParam[]): RunResult;
  get<T = Record<string, unknown>>(...params: SqlParam[]): T | undefined;
  all<T = Record<string, unknown>>(...params: SqlParam[]): T[];
}

export type SqlParam = string | number | bigint | Uint8Array | null;

export interface Db {
  /** Execute one or more statements with no parameters and no result. */
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  /**
   * Run `fn` atomically. Nested calls use SAVEPOINTs, so a helper that opens a
   * transaction stays correct when called from inside another one.
   */
  transaction<T>(fn: () => T): T;
  pragma(statement: string): void;
  close(): void;
}
