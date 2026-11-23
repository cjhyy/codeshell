import { createRequire } from "node:module";

export type SqlValue = string | number | bigint | Uint8Array | null;
export interface StorageStatement {
  sql: string;
  params?: readonly SqlValue[];
}

interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: SqlValue[]): unknown[];
    get(...params: SqlValue[]): unknown;
    run(...params: SqlValue[]): unknown;
    finalize?(): void;
  };
  close(): void;
}

export class StorageDatabase {
  constructor(private readonly native: NativeDatabase) {}

  private statement(
    sql: string,
    operation: "all" | "get" | "run",
    params: readonly SqlValue[],
  ): unknown {
    const stmt = this.native.prepare(sql);
    try {
      return stmt[operation](...params);
    } finally {
      stmt.finalize?.();
    } // Bun otherwise defers sqlite3_close_v2 and WAL cleanup until GC.
  }
  all<T = Record<string, SqlValue>>(sql: string, params: readonly SqlValue[] = []): T[] {
    return this.statement(sql, "all", params) as T[];
  }
  get<T = Record<string, SqlValue>>(sql: string, params: readonly SqlValue[] = []): T | undefined {
    return (this.statement(sql, "get", params) ?? undefined) as T | undefined;
  }
  run(sql: string, params: readonly SqlValue[] = []): void {
    this.statement(sql, "run", params);
  }
  exec(sql: string): void {
    this.native.exec(sql);
  }
  transaction<T>(callback: () => T): T {
    this.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      if (result instanceof Promise) throw new Error("SQLite transactions must be synchronous");
      this.exec("COMMIT");
      return result;
    } catch (error) {
      // SQLite has already ended the transaction after errors such as SQLITE_FULL
      // or SQLITE_IOERR. The caller classifies availability from the original code.
      try {
        this.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  close(): void {
    this.native.close();
  }
}

type OpenDatabase = (file: string, readOnly?: boolean) => StorageDatabase;
const load = createRequire(import.meta.url);

/** Probe the runtime's actual native driver. Node 20 can load this module
 * without resolving either optional builtin or installing a native addon. */
export function sqliteDriver(): OpenDatabase | undefined {
  try {
    if (process.versions.bun) {
      const { Database } = load("bun:sqlite");
      return (file, readOnly = false) =>
        new StorageDatabase(
          new Database(file, readOnly ? { readonly: true } : { create: true, readwrite: true }),
        );
    }
    const { DatabaseSync } = load("node:sqlite");
    if (typeof DatabaseSync !== "function") return undefined;
    return (file, readOnly = false) => new StorageDatabase(new DatabaseSync(file, { readOnly }));
  } catch {
    return undefined;
  }
}
