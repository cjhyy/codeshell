import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  openSync,
  readSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { acquireLockOnPath } from "../utils/file-mutex.js";
import { sqliteDriver, type StorageDatabase } from "./driver.js";
import { migrate, UnrecognizedStorageSchema } from "./schema.js";

function isCorruption(error: unknown): boolean {
  const sql = error as { errcode?: number; code?: string };
  return (
    error instanceof UnrecognizedStorageSchema ||
    sql?.code === "SQLITE_CORRUPT" ||
    sql?.code === "SQLITE_NOTADB" ||
    (Number(sql?.errcode) & 255) === 11 ||
    (Number(sql?.errcode) & 255) === 26
  );
}

/** Detect an obviously damaged header before a writable SQLite open has a
 * chance to replay a surviving WAL into the evidence being quarantined. */
function checkHeader(file: string): void {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const header = Buffer.alloc(16);
    const bytes = readSync(fd, header, 0, header.length, 0);
    if (bytes && (bytes !== header.length || header.toString("latin1") !== "SQLite format 3\0"))
      throw new UnrecognizedStorageSchema("Invalid SQLite file header");
  } finally {
    closeSync(fd);
  }
}

/** Replacing an open WAL database invalidates other processes' file handles.
 * While holding the initialization lock, check live owners before quarantine.
 * A dead process's lease can be reclaimed without touching any live handle. */
function hasLiveHandles(leases: string): boolean {
  for (const name of readdirSync(leases)) {
    const pid = Number(name.split(".")[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
      unlinkSync(join(leases, name));
    }
  }
  return false;
}

export function releaseLease(file: string | undefined): void {
  if (!file) return;
  try {
    unlinkSync(file);
  } catch {
    /* A left-over lease keeps recovery conservative. */
  }
}

function privateDirectory(path: string): string {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!lstatSync(path).isDirectory()) throw new Error("Storage directory is not ordinary");
  return path;
}

function checkDatabaseFiles(file: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const stat = lstatSync(file + suffix, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1))
      throw new Error("Unsafe storage database file");
  }
}

export function openWriter(sessionsRoot: string, token: string) {
  const open = sqliteDriver();
  if (!open) return undefined;
  mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
  if (!lstatSync(sessionsRoot).isDirectory())
    throw new Error("Storage root is not an ordinary directory");
  const root = realpathSync(sessionsRoot);
  const key = createHash("sha256").update(basename(root)).digest("hex");
  // Sibling roots can share a parent. Keep auxiliary files outside the roots
  // themselves so old directory scanners see exactly the original candidates.
  const container = privateDirectory(
    join(privateDirectory(join(dirname(root), ".codeshell-state")), key),
  );
  const unlock = acquireLockOnPath(container);
  try {
    const live = join(container, "current");
    const leases = join(container, "handles");
    const file = join(live, "state.sqlite");
    const lease = join(leases, `${process.pid}.${token}`);
    privateDirectory(leases);
    const initialize = (): StorageDatabase => {
      privateDirectory(live);
      checkDatabaseFiles(file);
      checkHeader(file);
      const db = open(file);
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        const check = db.get<{ quick_check: string }>("PRAGMA quick_check(1)");
        if (check?.quick_check !== "ok")
          throw new UnrecognizedStorageSchema("Invalid SQLite index");
        if (db.get<{ journal_mode: string }>("PRAGMA journal_mode=WAL")?.journal_mode !== "wal")
          throw new Error("SQLite WAL is unavailable");
        migrate(db);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    };
    let db: StorageDatabase;
    try {
      db = initialize();
    } catch (error) {
      if (!isCorruption(error) || hasLiveHandles(leases)) throw error;
      // Rename database, WAL and SHM together, including after an unclean exit.
      renameSync(live, join(container, `quarantine-${Date.now()}-${randomUUID()}`));
      db = initialize();
    }
    try {
      writeFileSync(lease, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      db.close();
      throw error;
    }
    return { db, file, lease };
  } finally {
    unlock();
  }
}
