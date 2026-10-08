import { randomUUID, createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  previewProfilePluginExport,
  safeExportRelativePath,
  type ProfilePluginExportSnapshot,
} from "@cjhyy/code-shell-core/internal";
import type { ProfilePluginExportPreview } from "../shared/profile-plugin-export.js";

function identity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function directory(path: string): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("export destination must be a non-symlink directory");
  return stat;
}

/** Exclusive new directory; no rename, overwrite, recursive cleanup or source reread. */
export function writeProfilePluginSnapshot(
  snapshot: ProfilePluginExportSnapshot,
  chosenPath: string,
): void {
  if (!snapshot.canExport)
    throw new Error("select at least one loadable component and resolve selected blockers");
  if (
    snapshot.files.length > 256 ||
    snapshot.totalBytes > 4 * 1024 * 1024 ||
    snapshot.files.some((file) => file.bytes > 256 * 1024)
  )
    throw new Error("reviewed export exceeds its storage budget");
  let parent: string, parentIdentity: BigIntStats;
  try {
    directory(dirname(chosenPath));
    parent = realpathSync(dirname(chosenPath));
    parentIdentity = directory(parent);
  } catch {
    throw new Error("export destination parent is unavailable or unsafe");
  }
  const name = basename(chosenPath);
  if (!safeExportRelativePath(name) || name.includes("/"))
    throw new Error("invalid export directory name");
  const root = join(parent, name);
  const createdDirs = new Map<string, BigIntStats>();
  const createdFiles = new Map<string, BigIntStats>();
  const assertDirs = () => {
    if (!identity(parentIdentity, directory(parent))) throw new Error("export parent changed");
    for (const [path, stat] of createdDirs)
      if (!identity(stat, directory(path))) throw new Error("export directory changed");
  };
  const flushDirs = () => {
    // Windows does not support this directory-open/fsync operation. Regular
    // files are flushed there; POSIX additionally orders directory publication.
    if (process.platform === "win32") return;
    for (const dir of [...createdDirs.keys()].reverse().concat(parent)) {
      const fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!identity(directory(dir), fstatSync(fd, { bigint: true })))
          throw new Error("export directory changed while flushing");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  };
  // mkdir, unlike POSIX rename, cannot replace a pre-existing empty directory.
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch {
    throw new Error(
      "export destination already exists or cannot be created; choose a new directory",
    );
  }
  createdDirs.set(root, directory(root));
  try {
    // Manifest is the publication marker and is written only after every other file.
    const files = [...snapshot.files].sort(
      (a, b) =>
        Number(a.path === ".claude-plugin/plugin.json") -
        Number(b.path === ".claude-plugin/plugin.json"),
    );
    for (const file of files) {
      if (
        !safeExportRelativePath(file.path) ||
        Buffer.byteLength(file.text) !== file.bytes ||
        createHash("sha256").update(file.text).digest("hex") !== file.sha256
      )
        throw new Error("reviewed snapshot failed integrity validation");
      assertDirs();
      const parts = file.path.split("/");
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        dir = join(dir, part);
        if (!createdDirs.has(dir)) {
          mkdirSync(dir, { mode: 0o700 });
          createdDirs.set(dir, directory(dir));
        }
      }
      // Persist every payload directory entry (and the new package root) before
      // publishing the manifest. A failed payload barrier leaves no manifest.
      if (file.path === ".claude-plugin/plugin.json") {
        assertDirs();
        flushDirs();
      }
      const path = join(root, ...parts);
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = fstatSync(fd, { bigint: true });
        createdFiles.set(path, stat);
        assertDirs();
        if (!stat.isFile() || !identity(stat, lstatSync(path, { bigint: true })))
          throw new Error("export file changed while opening");
        const bytes = Buffer.from(file.text);
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (written <= 0) throw new Error("export write made no progress");
          offset += written;
        }
        fsyncSync(fd);
        assertDirs();
        if (
          !identity(stat, lstatSync(path, { bigint: true })) ||
          fstatSync(fd, { bigint: true }).size !== BigInt(bytes.length)
        )
          throw new Error("export file changed while writing");
      } finally {
        closeSync(fd);
      }
    }
    assertDirs();
    flushDirs();
  } catch {
    // Never recursively remove unknown additions, a replaced directory, or an
    // unrelated file. A failed cleanup may leave an incomplete private directory.
    for (const [path, stat] of [...createdFiles].reverse()) {
      try {
        assertDirs();
        if (identity(stat, lstatSync(path, { bigint: true }))) unlinkSync(path);
      } catch {
        /* preserve unknown/replaced contents */
      }
    }
    for (const [path, stat] of [...createdDirs].reverse()) {
      try {
        if (identity(stat, directory(path))) rmdirSync(path);
      } catch {
        /* nonempty or replaced: preserve */
      }
    }
    throw new Error(
      "plugin export failed; no existing directory was overwritten (an incomplete directory may remain)",
    );
  }
}

interface Review {
  owner: number;
  context: string;
  snapshot: ProfilePluginExportSnapshot;
  timer: ReturnType<typeof setTimeout>;
}

/** At most four 4-MiB private snapshots, one per renderer owner, expiring after ten minutes. */
export class ProfilePluginExportReviews {
  private reviews = new Map<string, Review>();
  preview(
    owner: number,
    context: string,
    name: string,
    cwd: string,
    selection: unknown,
  ): ProfilePluginExportPreview {
    this.clearOwner(owner);
    if (this.reviews.size >= 4) throw new Error("too many pending plugin export reviews");
    const snapshot = previewProfilePluginExport(name, cwd, selection);
    const reviewToken = randomUUID();
    const timer = setTimeout(() => this.cancel(owner, reviewToken), 10 * 60 * 1000);
    timer.unref();
    this.reviews.set(reviewToken, { owner, context, snapshot, timer });
    return { ...snapshot, reviewToken };
  }
  get(owner: number, context: string, token: string): ProfilePluginExportSnapshot {
    const review = this.reviews.get(token);
    if (!review || review.owner !== owner || review.context !== context)
      throw new Error("plugin export review expired or its configuration context changed");
    return review.snapshot;
  }
  cancel(owner: number, token: string): void {
    const review = this.reviews.get(token);
    if (review?.owner !== owner) return;
    clearTimeout(review.timer);
    this.reviews.delete(token);
  }
  clearOwner(owner: number): void {
    for (const [token, review] of this.reviews)
      if (review.owner === owner) this.cancel(owner, token);
  }
  commit(
    owner: number,
    context: string,
    token: string,
    acceptLosses: unknown,
    chosenPath: string,
  ): void {
    if (acceptLosses !== true)
      throw new Error("explicit acceptance of the reviewed losses is required");
    const snapshot = this.get(owner, context, token);
    this.cancel(owner, token); // one shot, including write failure
    writeProfilePluginSnapshot(snapshot, chosenPath);
  }
}
