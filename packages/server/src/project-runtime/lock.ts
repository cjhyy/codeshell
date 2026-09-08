import { lstatSync } from "node:fs";
import { lockSync } from "@cjhyy/code-shell-core/internal";

export interface ProjectControllerLock {
  assertHeld(): void;
  release(): void;
}

/** One control process per directory; heartbeat leases recover after a crash. */
export function acquireProjectControllerLock(directory: string): ProjectControllerLock {
  const original = lstatSync(directory);
  if (!original.isDirectory() || original.isSymbolicLink())
    throw new Error("Unsafe project control directory.");
  let compromised = false;
  let released = false;
  let unlock: () => void;
  try {
    unlock = lockSync(directory, {
      stale: 30000,
      update: 10000,
      retries: 0,
      onCompromised: () => {
        compromised = true;
      },
    });
  } catch {
    throw new Error(
      "Another project controller owns this data directory; stop it before starting another.",
    );
  }
  return {
    assertHeld() {
      if (released || compromised) throw new Error("Project controller lock is no longer held.");
      const current = lstatSync(directory);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== original.dev ||
        current.ino !== original.ino
      )
        throw new Error("Project control directory changed while the controller was running.");
    },
    release() {
      if (released) return;
      released = true;
      if (!compromised) unlock();
    },
  };
}
