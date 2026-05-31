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

import { createRequire } from 'node:module'
import type { CheckOptions, LockOptions, UnlockOptions } from 'proper-lockfile'

type Lockfile = typeof import('proper-lockfile')

// proper-lockfile is CommonJS. This module compiles to ESM (tsc module: ESNext,
// package "type":"module"), and `require` is NOT a global in ESM — under the
// Electron main process (an ESM bundle that loads core as an external ESM dep)
// a bare `require('proper-lockfile')` throws "require is not defined", which
// surfaced as run locks silently failing ("Run now does nothing"). createRequire
// gives us a CJS-capable require that works in both ESM and CJS/Bun hosts.
const nodeRequire = createRequire(import.meta.url)

let _lockfile: Lockfile | undefined

function getLockfile(): Lockfile {
  if (!_lockfile) {
    _lockfile = nodeRequire('proper-lockfile') as Lockfile
  }
  return _lockfile
}

export function lock(
  file: string,
  options?: LockOptions,
): Promise<() => Promise<void>> {
  return getLockfile().lock(file, options)
}

export function lockSync(file: string, options?: LockOptions): () => void {
  return getLockfile().lockSync(file, options)
}

export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return getLockfile().unlock(file, options)
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return getLockfile().check(file, options)
}
