import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Cross-process workspace publication lock shared by Hosts and package CLIs.
 * A crashed writer leaves its lock for explicit recovery; never steal a lock
 * based on age while its owner might still be publishing a file. The caller
 * authorizes and pins the parent; it may be an open directory's /proc fd path.
 */
export async function acquireWorkspaceWriteLock(
  parentDirectory: string,
  filename: string,
): Promise<() => Promise<void>> {
  if (!filename || filename === "." || filename === ".." || /[/\\\0]/u.test(filename))
    throw new Error("workspace write lock requires a single filename");
  const name = createHash("sha256").update(filename.normalize("NFC").toLowerCase()).digest("hex");
  const lockPath = join(parentDirectory, `.codeshell-workspace-write-${name}.lock`);
  const parent = statSync(parentDirectory, { bigint: true });
  if (!parent.isDirectory()) throw new Error("workspace write lock parent must be a directory");
  const assertParent = () => {
    const current = statSync(parentDirectory, { bigint: true });
    if (!current.isDirectory() || current.dev !== parent.dev || current.ino !== parent.ino)
      throw new Error("workspace directory changed while waiting for a write lock");
  };
  const deadline = Date.now() + 5_000;
  for (;;) {
    assertParent();
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const existing = lstatSync(lockPath, { bigint: true });
        if (!existing.isDirectory() || existing.isSymbolicLink())
          throw new Error("workspace write lock is not a real directory", { cause: error });
      } catch (inspectionError) {
        // Its owner may release the directory between mkdir and inspection.
        if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") throw inspectionError;
      }
      if (Date.now() >= deadline)
        throw Object.assign(new Error("workspace file is locked by another writer"), {
          code: "ELOCKED",
        });
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  const acquired = lstatSync(lockPath, { bigint: true });
  if (!acquired.isDirectory() || acquired.isSymbolicLink())
    throw new Error("workspace write lock was compromised during acquisition");
  return async () => {
    try {
      assertParent();
      const current = lstatSync(lockPath, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== acquired.dev ||
        current.ino !== acquired.ino
      )
        throw new Error("workspace write lock identity changed");
      rmdirSync(lockPath);
    } catch (cause) {
      throw Object.assign(new Error("workspace write lock was compromised", { cause }), {
        code: "ELOCKCOMPROMISED",
      });
    }
  };
}
