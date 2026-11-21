import { createHash, randomUUID } from "node:crypto";
import {
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

export function openWriter(sessionsRoot: string, token: string) {
  const open = sqliteDriver();
  if (!open) return undefined;
  mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
  const root = realpathSync(sessionsRoot);
  const key = createHash("sha256").update(basename(root)).digest("hex");
  // Sibling roots can share a parent. Keep auxiliary files outside the roots
  // themselves so old directory scanners see exactly the original candidates.
  const container = join(dirname(root), ".codeshell-state", key);
  mkdirSync(container, { recursive: true, mode: 0o700 });
  const unlock = acquireLockOnPath(container);
  try {
    const live = join(container, "current");
    const leases = join(container, "handles");
    const file = join(live, "state.sqlite");
    const lease = join(leases, `${process.pid}.${token}`);
    mkdirSync(leases, { recursive: true, mode: 0o700 });
    const initialize = (): StorageDatabase => {
      mkdirSync(live, { recursive: true, mode: 0o700 });
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
