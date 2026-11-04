/**
 * Lazy accessor for proper-lockfile.
 *
 * proper-lockfile depends on graceful-fs, which monkey-patches every fs
 * method on first require (~8ms). Static imports of proper-lockfile pull this
 * cost into the startup path even when no locking happens (e.g. `--help`).
 *
 * Import this module instead of `proper-lockfile` directly. The underlying
 * package is only loaded the first time a lock function is actually called.
 */

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface LockRetryOptions {
  retries?: number;
  factor?: number;
  minTimeout?: number;
  maxTimeout?: number;
  randomize?: boolean;
  forever?: boolean;
  unref?: boolean;
  maxRetryTime?: number;
}

interface LockfilePathOptions {
  realpath?: boolean;
  /**
   * proper-lockfile accepts a callback-style fs implementation. Keep this
   * structural at the package boundary so Core's declarations do not leak the
   * untyped CommonJS dependency to TypeScript consumers.
   */
  fs?: object;
  lockfilePath?: string;
}

interface CheckOptions extends LockfilePathOptions {
  stale?: number;
}

type UnlockOptions = LockfilePathOptions;

interface LockOptions extends CheckOptions {
  update?: number;
  retries?: number | LockRetryOptions;
  onCompromised?: (error: Error) => void;
}

interface LockfileApi {
  lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  lockSync(file: string, options?: LockOptions): () => void;
  unlock(file: string, options?: UnlockOptions): Promise<void>;
  check(file: string, options?: CheckOptions): Promise<boolean>;
}

// proper-lockfile is CommonJS. This module compiles to ESM (tsc module: ESNext,
// package "type":"module"), and `require` is NOT a global in ESM — under the
// Electron main process (an ESM bundle that loads core as an external ESM dep)
// a bare `require('proper-lockfile')` throws "require is not defined", which
// surfaced as run locks silently failing ("Run now does nothing"). createRequire
// gives us a CJS-capable require that works in both ESM and CJS/Bun hosts.
const nodeRequire = createRequire(import.meta.url);

let _lockfile: LockfileApi | undefined;

function getLockfile(): LockfileApi {
  if (!_lockfile) {
    _lockfile = nodeRequire("proper-lockfile") as LockfileApi;
  }
  return _lockfile;
}

// Include pending async acquisition: its filesystem callback may have acquired
// the lease before its Promise continuation gets a chance to register ownership.
const localLocks = new Map<string, number>();
function lockKey(file: string, options?: LockfilePathOptions): string {
  const path = options?.lockfilePath
    ? resolve(options.lockfilePath)
    : `${options?.realpath === false ? resolve(file) : realpathSync(file)}.lock`;
  // realpath:false preserves the target's leaf identity, but parent aliases
  // (/var versus /private/var on macOS) still address the very same lease.
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}
function remember(key: string): () => void {
  localLocks.set(key, (localLocks.get(key) ?? 0) + 1);
  let forgotten = false;
  return () => {
    if (forgotten) return;
    forgotten = true;
    const count = localLocks.get(key)! - 1;
    if (count) localLocks.set(key, count);
    else localLocks.delete(key);
  };
}

export async function lock(file: string, options?: LockOptions): Promise<() => Promise<void>> {
  const forget = remember(lockKey(file, options));
  try {
    const release = await getLockfile().lock(file, options);
    return async () => {
      await release();
      forget();
    };
  } catch (error) {
    forget();
    throw error;
  }
}

export function lockSync(file: string, options?: LockOptions): () => void {
  const key = lockKey(file, options);
  const release = getLockfile().lockSync(file, options);
  const forget = remember(key);
  return () => {
    release();
    forget();
  };
}

export function isLockHeldInProcess(file: string, options?: LockfilePathOptions): boolean {
  return localLocks.has(lockKey(file, options));
}

/** Short synchronous CAS holders in another process may finish between attempts.
 * Never wait for this process: its async holder needs our event loop to release. */
export function lockSyncWithBoundedRetry(file: string, options?: LockOptions): () => void {
  const key = lockKey(file, options);
  const delays = [5, 10, 20, 40];
  for (let attempt = 0; ; attempt++) {
    try {
      return lockSync(file, options);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = delays[attempt];
      if ((code !== "ELOCKED" && code !== "EEXIST") || delay === undefined || localLocks.has(key))
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

export async function unlock(file: string, options?: UnlockOptions): Promise<void> {
  const key = lockKey(file, options);
  await getLockfile().unlock(file, options);
  const count = localLocks.get(key);
  if (count !== undefined) {
    if (count > 1) localLocks.set(key, count - 1);
    else localLocks.delete(key);
  }
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return getLockfile().check(file, options);
}
