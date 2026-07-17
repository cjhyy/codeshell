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

export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>> {
  return getLockfile().lock(file, options);
}

export function lockSync(file: string, options?: LockOptions): () => void {
  return getLockfile().lockSync(file, options);
}

export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return getLockfile().unlock(file, options);
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return getLockfile().check(file, options);
}
