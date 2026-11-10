import type { Stats } from "node:fs";
// Filesystem reads for the file-browser panel. Mirrors Codex's fs RPC
// (fs-read-directory / fs-read-file) but local-only: one directory level at a
// time so the renderer can lazily expand a tree, plus a capped file reader.
import { promises as fs, constants } from "node:fs";
import { isAbsolute, basename, dirname, join, normalize, resolve, sep } from "node:path";

export interface FsEntry {
  name: string;
  /** Absolute path. */
  path: string;
  isDirectory: boolean;
}

/** Names we never surface in the tree (noise / huge / VCS internals). */
const SKIP = new Set([".git", ".DS_Store", "node_modules", ".next", "dist", "out", ".cache"]);

/** Lexical containment check (after both paths are already real-pathed). */
function isWithin(root: string, target: string): boolean {
  const r = normalize(root);
  const t = normalize(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Canonicalize the existing ancestor, including dangling links, before a missing result. */
async function realpathAllowMissing(target: string, links = 0): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    let info: Stats | undefined;
    try {
      info = await fs.lstat(target);
    } catch (statError) {
      if (!["ENOENT", "ENOTDIR"].includes((statError as NodeJS.ErrnoException).code ?? ""))
        throw statError;
    }
    if (info?.isSymbolicLink()) {
      if (links >= 40) throw new Error("too many symbolic links", { cause: error });
      return realpathAllowMissing(resolve(dirname(target), await fs.readlink(target)), links + 1);
    }
    const parent = dirname(target);
    if (parent === target) throw error;
    return join(await realpathAllowMissing(parent, links), basename(target));
  }
}

/**
 * Resolve `target` through symlinks and verify it stays within the real
 * workspace root. This defeats symlink escapes: a link inside the repo that
 * points at ~/.ssh would pass a string-prefix check but fails here because
 * its realpath leaves the root. Throws on escape.
 */
async function resolveWithin(root: string, target: string): Promise<string> {
  // Cheap lexical reject first (before touching disk for a `..` traversal).
  if (!isWithin(root, target)) throw new Error("path escapes workspace root");
  const realRoot = await fs.realpath(root);
  // realpath requires the path to exist; for not-yet-existing paths fall back
  // to the lexical check against the real root.
  const realTarget = await realpathAllowMissing(target);
  if (!isWithin(realRoot, realTarget)) {
    throw new Error("path escapes workspace root");
  }
  return realTarget;
}

/** List one directory level, dirs first then files, both alphabetical. */
export async function readDirectory(root: string, dir: string): Promise<FsEntry[]> {
  await resolveWithin(root, dir);
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const realRoot = await fs.realpath(root);
  const entries: FsEntry[] = [];
  for (const d of dirents) {
    if (SKIP.has(d.name)) continue;
    const full = join(dir, d.name);
    let isDirectory = d.isDirectory();
    if (d.isSymbolicLink()) {
      // Resolve the link; drop it if it dangles OR escapes the workspace
      // root (so the tree can never be used to reach files outside root).
      try {
        const real = await fs.realpath(full);
        if (!isWithin(realRoot, real)) continue;
        isDirectory = (await fs.stat(full)).isDirectory();
      } catch {
        continue; // dangling symlink
      }
    }
    entries.push({ name: d.name, path: full, isDirectory });
  }
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

const MAX_FILE_BYTES = 2_000_000; // 2 MB — don't try to render giant files.

export interface FileContent {
  path: string;
  /** UTF-8 text, or null when the file is binary / too large. */
  text: string | null;
  /** Why text is null, if it is. */
  reason?: "too-large" | "binary" | "missing";
  size: number;
}

/**
 * Does `path` (absolute or relative to `root`) resolve to an existing regular
 * file inside the workspace root? Used to decide whether a path mentioned in an
 * answer should render as a clickable file link. Returns false — never throws —
 * for a missing file, a directory, or a path that escapes the root, so the
 * renderer can treat "unknown" as "not clickable".
 */
export async function fileExists(root: string, path: string): Promise<boolean> {
  try {
    // A path from an answer link is often RELATIVE (`README.md`,
    // `packages/x/y.ts`); resolveWithin only accepts a path already under root,
    // so join a non-absolute path onto root first. (readDir/readFile always get
    // absolute paths from the tree, so they never needed this.)
    const target = isAbsolute(path) ? path : join(root, path);
    const real = await resolveWithin(root, target);
    const stat = await fs.stat(real);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function readFile(root: string, path: string): Promise<FileContent> {
  const requestedPath = path;
  const real = await resolveWithin(root, path);
  path = real;
  let handle: fs.FileHandle | undefined;
  try {
    // Pin the ordinary-file identity before opening; O_NONBLOCK prevents a
    // replacement FIFO from consuming a libuv worker indefinitely.
    const before = await fs.lstat(path);
    if (!before.isFile()) throw new Error("workspace path is not a regular file");
    handle = await fs.open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile() || before.dev !== stat.dev || before.ino !== stat.ino)
      throw new Error("workspace file changed during read");
    const verify = async () => {
      if ((await resolveWithin(root, requestedPath)) !== real)
        throw new Error("workspace file changed during read");
      const current = await fs.lstat(real);
      if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino)
        throw new Error("workspace file changed during read");
    };
    await verify();
    if (stat.size > MAX_FILE_BYTES)
      return { path, text: null, reason: "too-large", size: stat.size };
    // Fixed allocation also bounds growth after fstat. Read only through the
    // authorized descriptor, never reopen the pathname after validation.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    await verify();
    if (offset > MAX_FILE_BYTES) return { path, text: null, reason: "too-large", size: offset };
    const buf = buffer.subarray(0, offset);
    if (buf.subarray(0, 8192).includes(0))
      return { path, text: null, reason: "binary", size: offset };
    return { path, text: buf.toString("utf8"), size: offset };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
      return { path: requestedPath, text: null, reason: "missing", size: 0 };
    throw error;
  } finally {
    await handle?.close();
  }
}
