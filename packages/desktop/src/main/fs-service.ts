// Filesystem reads for the file-browser panel. Mirrors Codex's fs RPC
// (fs-read-directory / fs-read-file) but local-only: one directory level at a
// time so the renderer can lazily expand a tree, plus a capped file reader.
import { promises as fs } from "node:fs";
import { join, normalize, sep } from "node:path";

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
  let realTarget: string;
  try {
    realTarget = await fs.realpath(target);
  } catch {
    if (!isWithin(realRoot, normalize(target))) {
      throw new Error("path escapes workspace root");
    }
    return target;
  }
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
  reason?: "too-large" | "binary";
  size: number;
}

export async function readFile(root: string, path: string): Promise<FileContent> {
  const real = await resolveWithin(root, path);
  path = real;
  const stat = await fs.stat(path);
  if (stat.size > MAX_FILE_BYTES) {
    return { path, text: null, reason: "too-large", size: stat.size };
  }
  const buf = await fs.readFile(path);
  // Heuristic binary sniff: a NUL byte in the first 8 KB.
  const sniff = buf.subarray(0, 8192);
  if (sniff.includes(0)) {
    return { path, text: null, reason: "binary", size: stat.size };
  }
  return { path, text: buf.toString("utf8"), size: stat.size };
}
