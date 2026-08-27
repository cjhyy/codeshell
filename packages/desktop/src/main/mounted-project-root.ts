import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import { canonicalKey } from "@cjhyy/code-shell-core/internal";

export interface MountedProjectRootRecord {
  path: string;
  canonicalIdentity?: string;
}

export type MountedProjectRootStatus = "ok" | "dir_missing" | "root_replaced";

export interface MountedProjectRootValidation {
  status: MountedProjectRootStatus;
  path: string;
  canonicalIdentity?: string;
  reason?: "directory_missing" | "identity_mismatch";
  message?: string;
}

const CASE_INSENSITIVE_PLATFORM = process.platform === "darwin" || process.platform === "win32";

/** A comparison key that never follows the current filesystem target. */
export function storedProjectRootIdentityKey(root: MountedProjectRootRecord): string {
  const input = root.canonicalIdentity ?? root.path;
  const absolute = resolve(input);
  const filesystemRoot = parse(absolute).root;
  let end = absolute.length;
  while (end > filesystemRoot.length && (absolute[end - 1] === "/" || absolute[end - 1] === "\\")) {
    end -= 1;
  }
  const normalized = absolute.slice(0, end);
  return CASE_INSENSITIVE_PLATFORM ? normalized.toLocaleLowerCase("en-US") : normalized;
}

/**
 * Normalize benign ancestor aliases without ever following the root leaf.
 * This lets persisted `/var/.../repo` match registered
 * `/private/var/.../repo` on macOS while a new `repo -> outside` leaf remains
 * identified by its original mount location.
 */
export function storedProjectRootPathKey(path: string): string {
  const absolute = resolve(path);
  try {
    const parent = realpathSync(dirname(absolute));
    return storedProjectRootIdentityKey({ path: resolve(parent, basename(absolute)) });
  } catch {
    return storedProjectRootIdentityKey({ path: absolute });
  }
}

/** Capture identity only for a direct directory selected through Main. */
export function captureProjectRootIdentity(path: string): {
  path: string;
  canonicalIdentity: string;
} {
  if (!isAbsolute(path)) throw new Error("project root must be an absolute directory");
  // Strip a trailing separator before lstat: on some platforms `lstat("link/")`
  // follows the link because the slash requests a directory target.
  const mountPath = resolve(path);
  const info = lstatSync(mountPath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("project root must be a non-symlink directory");
  }
  const real = realpathSync(mountPath);
  return { path: real, canonicalIdentity: real };
}

/**
 * Safely backfill an old V2 root only when its stored path still names the
 * same direct directory. In particular, never bless the current target of a
 * symlink that appeared after the old record was written.
 */
export function backfillProjectRootIdentity(root: MountedProjectRootRecord): string | undefined {
  if (root.canonicalIdentity) return root.canonicalIdentity;
  try {
    const mountPath = resolve(root.path);
    const info = lstatSync(mountPath);
    if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    const real = realpathSync(mountPath);
    // lstat above proves the leaf itself is not a symlink. canonicalKey may
    // still normalize platform ancestor aliases such as macOS /var ->
    // /private/var, which old V2 records legitimately contain.
    if (canonicalKey(real) !== canonicalKey(root.path)) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

/** Validate the mount itself before its path enters any authority object. */
export function validateMountedProjectRoot(
  root: MountedProjectRootRecord,
): MountedProjectRootValidation {
  const mountPath = resolve(root.path);
  let info;
  try {
    info = lstatSync(mountPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "dir_missing",
        path: root.path,
        reason: "directory_missing",
        message: `project root status dir_missing: directory is missing: ${root.path}`,
      };
    }
    return {
      status: "root_replaced",
      path: root.path,
      reason: "identity_mismatch",
      message: `project root status root_replaced: root identity cannot be verified: ${root.path}`,
    };
  }

  if (info.isSymbolicLink() || !info.isDirectory() || !root.canonicalIdentity) {
    return {
      status: "root_replaced",
      path: root.path,
      reason: "identity_mismatch",
      message: `project root status root_replaced: registered directory identity changed: ${root.path}`,
    };
  }

  try {
    const real = realpathSync(mountPath);
    if (canonicalKey(real) !== canonicalKey(root.canonicalIdentity)) {
      return {
        status: "root_replaced",
        path: root.path,
        canonicalIdentity: real,
        reason: "identity_mismatch",
        message: `project root status root_replaced: registered directory identity changed: ${root.path}`,
      };
    }
    return { status: "ok", path: real, canonicalIdentity: real };
  } catch {
    return {
      status: "root_replaced",
      path: root.path,
      reason: "identity_mismatch",
      message: `project root status root_replaced: root identity cannot be verified: ${root.path}`,
    };
  }
}

export function requireMountedProjectRoot(root: MountedProjectRootRecord): string {
  const validation = validateMountedProjectRoot(root);
  if (validation.status !== "ok") {
    throw new Error(validation.message ?? `project root status ${validation.status}`);
  }
  return validation.path;
}
