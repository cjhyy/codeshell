/**
 * Cross-process read-modify-write for a single JSON file.
 *
 * WHY THIS EXISTS
 * ---------------
 * Several subsystems independently implemented "load → change → save" against a
 * shared file with NO cross-process lock. Atomic tmp+rename protects against a
 * torn file, but not against lost updates: two processes both read revision N,
 * both write N+1, and one change vanishes. Measured on this repo: 48 concurrent
 * writers each setting a distinct settings key left only 17 keys; 48 concurrent
 * AutoDream increments recorded 1–2.
 *
 * CronStore already had the correct shape (directory lock + reload-inside-lock +
 * unique tmp + rename). This module extracts exactly that so every writer shares
 * one implementation instead of re-deriving it — and so the retry/stale tuning
 * lives in one place.
 *
 * The lock is taken on the file's DIRECTORY (proper-lockfile creates
 * `<dir>.lock`), matching CronStore. Locking the directory rather than the file
 * means a writer that creates the file for the first time is still serialized.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { lockSync } from "./lockfile.js";

/**
 * How long to keep retrying the lock before giving up.
 *
 * Sized for real contention, not the happy path. Every holder does a bounded
 * amount of work (re-read, merge, atomic rename), but with N writers the last
 * one in line waits for all N-1 ahead of it. Measured here: 48 concurrent
 * processes saving memories against one index blew through a 2s budget and up to
 * 46 of them died with ELOCKED. 30s leaves generous headroom while still
 * failing loudly if a holder is genuinely wedged.
 */
const LOCK_WAIT_MS = 30_000;
/** A lock older than this is treated as abandoned by a crashed holder. */
const LOCK_STALE_MS = 10_000;
/** Backoff bounds for the retry loop (see acquireLockOn). */
const LOCK_RETRY_MIN_MS = 5;
const LOCK_RETRY_MAX_MS = 50;

// Atomics.wait only ever reads slot 0, which stays 0, so one shared buffer is
// safe and avoids allocating per retry.
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_SIGNAL, 0, 0, ms);
}

/**
 * Acquire the directory lock guarding `file`. Returns the release function.
 *
 * Retries for LOCK_WAIT_MS because contention here is normal (several hosts can
 * write the same file), then throws — a caller must never silently proceed
 * unlocked, since that is precisely the lost-update bug.
 */
export function acquireFileLock(file: string): () => void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return acquireLockOn(dir, LOCK_WAIT_MS);
}

/**
 * Lock one specific path rather than its whole directory.
 *
 * Use when several independent resources live side by side and must NOT
 * serialize against each other — e.g. per-repo clone dirs, where locking the
 * shared parent would make unrelated installs queue behind one another (and
 * would deadlock against any directory-scoped lock taken inside).
 *
 * `target` must already exist; proper-lockfile creates a sibling `<target>.lock`.
 * `timeoutMs` can exceed the default when the critical section legitimately
 * takes a while (network clone + directory swap).
 */
export function acquireLockOnPath(target: string, timeoutMs = LOCK_WAIT_MS): () => void {
  return acquireLockOn(target, timeoutMs);
}

function acquireLockOn(target: string, timeoutMs: number): () => void {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let attempt = 0;
  for (;;) {
    try {
      return lockSync(target, { stale: LOCK_STALE_MS, retries: 0 });
    } catch (err) {
      lastError = err;
      if (Date.now() > deadline) throw lastError;
      // Randomized backoff. A fixed delay makes every waiter wake at the same
      // instant and collide again, so under real contention (dozens of writers)
      // the same unlucky processes kept losing and eventually timed out.
      // Jitter spreads the retries out; the cap keeps latency low when only a
      // couple of writers are competing.
      const ceiling = Math.min(LOCK_RETRY_MIN_MS * 2 ** attempt, LOCK_RETRY_MAX_MS);
      attempt += 1;
      sleepSync(LOCK_RETRY_MIN_MS + Math.floor(Math.random() * ceiling));
    }
  }
}

/** Stage to a unique temp file, then rename — never a partially written target. */
export function writeFileAtomic(file: string, contents: string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  // Unique per writer: a shared `.tmp` name lets two writers clobber each
  // other's staging file even while both hold different locks.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, contents, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Run `mutation` against the file's CURRENT on-disk content while holding the
 * lock, then persist whatever it returns.
 *
 * The reload happens INSIDE the lock, which is the entire point: a caller that
 * read the file earlier (before contending for the lock) would otherwise write
 * back a stale snapshot and drop a concurrent writer's change.
 *
 * `parse` receives `undefined` when the file is missing or unreadable, so each
 * caller decides what "empty" means. Returning `undefined` from `mutation`
 * skips the write entirely (no-op mutations should not rewrite the file).
 */
export function mutateJsonFile<T, R = void>(
  file: string,
  options: {
    parse: (raw: string | undefined) => T;
    serialize: (value: T) => string;
    mutation: (current: T) => { value?: T; result?: R };
    mode?: number;
  },
): R | undefined {
  const release = acquireFileLock(file);
  try {
    let raw: string | undefined;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      raw = undefined;
    }
    const current = options.parse(raw);
    const { value, result } = options.mutation(current);
    if (value !== undefined) {
      writeFileAtomic(file, options.serialize(value), options.mode);
    }
    return result;
  } finally {
    release();
  }
}
