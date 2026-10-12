import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { lockSync } from "@cjhyy/code-shell-core/internal";

export interface ProjectControllerLock {
  assertHeld(): void;
  release(): void;
}

/** One control process per directory; heartbeat leases recover after a crash. */
export function acquireProjectControllerLock(directory: string): ProjectControllerLock {
  directory = resolve(directory);
  const original = fs.lstatSync(directory);
  if (!original.isDirectory() || original.isSymbolicLink())
    throw new Error("Unsafe project control directory.");
  const lockPath = `${directory}.lock`;
  let identity: fs.Stats | undefined;
  let candidate: fs.Stats | undefined;
  let owner: { name: string; identity: fs.Stats } | undefined;
  let candidateOwner: typeof owner;
  let mtime: number | undefined;
  let compromised = false;
  let released = false;
  const sameDirectory = (actual: fs.Stats, expected: fs.Stats) =>
    actual.isDirectory() &&
    !actual.isSymbolicLink() &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino;
  const ownerFile = (actual: fs.Stats) =>
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    actual.nlink === 1 &&
    actual.size === 0 &&
    (actual.mode & 0o077) === 0;
  function readOwner() {
    const entries = fs.readdirSync(lockPath);
    if (!entries.length) return; // A historical proper-lockfile owner had no marker.
    if (
      entries.length !== 1 ||
      !/^\.owner-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entries[0]!)
    )
      throw lost();
    const identity = fs.lstatSync(join(lockPath, entries[0]!));
    if (!ownerFile(identity)) throw lost();
    return { name: entries[0]!, identity };
  }
  function assertOwner(expected: NonNullable<typeof owner>) {
    const current = readOwner();
    if (
      !current ||
      current.name !== expected.name ||
      current.identity.dev !== expected.identity.dev ||
      current.identity.ino !== expected.identity.ino
    )
      throw lost();
  }
  const lost = () => {
    compromised = true;
    // ENOENT terminates proper-lockfile's renewal immediately, rather than
    // repeatedly retrying an owner which has already permanently lost custody.
    return Object.assign(new Error("Project controller lock is no longer held."), {
      code: "ENOENT",
    });
  };
  function assertRoot() {
    if (compromised) throw lost();
    try {
      if (!sameDirectory(fs.lstatSync(directory), original)) throw lost();
    } catch {
      throw lost();
    }
  }
  function assertOwned() {
    assertRoot();
    try {
      const current = fs.lstatSync(lockPath);
      if (
        !identity ||
        !owner ||
        !sameDirectory(current, identity) ||
        (mtime !== undefined && current.mtimeMs !== mtime)
      )
        throw lost();
      assertOwner(owner);
    } catch {
      throw lost();
    }
  }
  // lockSync's adapter invokes these synchronous functions for acquisition,
  // every heartbeat and exit cleanup. Guarding only callback-style fs methods
  // would leave its renewal and release paths unprotected.
  const guardedFs = {
    ...fs,
    mkdirSync(path: string) {
      if (path !== lockPath) return fs.mkdirSync(path);
      assertRoot();
      fs.mkdirSync(path, { mode: 0o700 });
      identity = fs.lstatSync(path);
      const name = `.owner-${randomUUID()}`;
      const marker = fs.openSync(
        join(path, name),
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        owner = { name, identity: fs.fstatSync(marker) };
        if (!ownerFile(owner.identity)) throw lost();
      } finally {
        fs.closeSync(marker);
      }
      mtime = fs.lstatSync(path).mtimeMs;
      assertOwned();
    },
    statSync(path: string) {
      if (path !== lockPath) return fs.statSync(path);
      if (identity) assertOwned();
      else assertRoot();
      const current = fs.lstatSync(path);
      if (!current.isDirectory() || current.isSymbolicLink()) throw lost();
      // An existing stale lock may be removed only if it remains the exact
      // directory whose age proper-lockfile just inspected.
      if (!identity) {
        candidate = current;
        candidateOwner = readOwner();
      }
      return current;
    },
    utimesSync(path: string, atime: fs.TimeLike, nextMtime: fs.TimeLike) {
      if (path !== lockPath) return fs.utimesSync(path, atime, nextMtime);
      assertOwned();
      const descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!sameDirectory(fs.fstatSync(descriptor), identity!)) throw lost();
        // Renew the captured inode, never a replacement installed between the
        // path check and the write. Recheck the public path before accepting it.
        fs.futimesSync(descriptor, atime, nextMtime);
        mtime = fs.fstatSync(descriptor).mtimeMs;
        assertOwned();
      } catch {
        throw lost();
      } finally {
        fs.closeSync(descriptor);
      }
    },
    rmdirSync(path: string) {
      if (path !== lockPath) return fs.rmdirSync(path);
      if (identity) {
        assertOwned();
        fs.unlinkSync(join(path, owner!.name));
      } else {
        assertRoot();
        if (!candidate || !sameDirectory(fs.lstatSync(path), candidate)) throw lost();
        if (candidateOwner) {
          assertOwner(candidateOwner);
          fs.unlinkSync(join(path, candidateOwner.name));
        } else if (fs.readdirSync(path).length) throw lost();
      }
      // Only our own random marker (or the exact observed stale candidate's)
      // was removed. If the pathname changes immediately before this syscall,
      // an established new owner still has its different marker: ENOTEMPTY
      // preserves it, and stale acquisition must fail rather than claim success.
      fs.rmdirSync(path);
    },
  };
  let unlock: () => void;
  try {
    unlock = lockSync(directory, {
      realpath: false,
      lockfilePath: lockPath,
      stale: 30000,
      update: 10000,
      retries: 0,
      fs: guardedFs,
      onCompromised: () => {
        compromised = true;
      },
    });
    assertOwned();
  } catch (error) {
    throw new Error(
      compromised
        ? "Project controller lock is no longer held."
        : "Another project controller owns this data directory; stop it before starting another.",
      { cause: error },
    );
  }
  return {
    assertHeld() {
      if (released || compromised) throw new Error("Project controller lock is no longer held.");
      assertOwned();
    },
    release() {
      if (released) return;
      released = true;
      try {
        assertOwned();
      } catch {
        return; // The lost owner may never delete another owner's replacement.
      }
      unlock();
    },
  };
}
