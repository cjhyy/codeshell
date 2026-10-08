import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROFILE_PLUGIN_EXPORT_LIMITS as LIMITS } from "./plugin-export-types.js";

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  );
}
export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
export function safeSegment(name: string): boolean {
  return (
    name.length > 0 && name.length <= 256 && name !== "." && name !== ".." && !/[\\/\0:]/.test(name)
  );
}
export function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** A bounded selected-text reader, independent of permissive runtime scanners. */
export class ProfileExportReader {
  private bytes = 0;
  private entries = 0;
  private directoryInventories = new Map<string, { stat: BigIntStats; names: Set<string> }>();

  /** Inspect literal names without ever joining a renderer/Profile name containing ':'. */
  hasLiteralDirectory(root: string, name: string): boolean {
    const before = lstatSync(root, { bigint: true });
    const cached = this.directoryInventories.get(root);
    if (cached) {
      if (!sameFile(cached.stat, before))
        throw new Error("source directory changed while resolving names");
      return cached.names.has(name);
    }
    const names = new Set<string>();
    const dir = opendirSync(root);
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++this.entries > LIMITS.files) throw new Error("source inventory exceeds 256 entries");
        if (entry.isDirectory() || entry.isSymbolicLink()) names.add(entry.name);
      }
    } finally {
      dir.closeSync();
    }
    if (!sameFile(before, lstatSync(root, { bigint: true })))
      throw new Error("source directory changed while resolving names");
    this.directoryInventories.set(root, { stat: before, names });
    return names.has(name);
  }

  directory(path: string, boundary?: string): string | undefined {
    try {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("source directory is not a regular, non-symlink directory");
      if (boundary) this.chain(boundary, path);
      const resolved = realpathSync(path);
      if (
        (boundary && !contained(boundary, resolved)) ||
        !sameIdentity(stat, lstatSync(resolved, { bigint: true })) ||
        !sameFile(stat, lstatSync(path, { bigint: true }))
      )
        throw new Error("source directory changed while resolving");
      return resolved;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  private chain(root: string, path: string): Array<[string, BigIntStats]> {
    const normalized = resolve(path);
    if (!contained(root, normalized)) throw new Error("source escapes its component root");
    const rel = relative(root, normalized);
    const parts = rel ? rel.split(sep) : [];
    const chain: Array<[string, BigIntStats]> = [];
    let current = root;
    for (let index = 0; index <= parts.length; index++) {
      const stat = lstatSync(current, { bigint: true });
      if (stat.isSymbolicLink() || (index < parts.length && !stat.isDirectory())) {
        throw new Error("symlink or non-directory in source path");
      }
      chain.push([current, stat]);
      if (index < parts.length) current = join(current, parts[index]);
    }
    if (!contained(root, realpathSync(normalized)))
      throw new Error("source escapes its component root");
    return chain;
  }

  read(root: string, path: string): string {
    const before = this.chain(root, path);
    const expected = before[before.length - 1][1];
    if (!expected.isFile() || expected.size > BigInt(LIMITS.textBytes)) {
      throw new Error("selected text must be a regular file of at most 256 KiB");
    }
    if (this.bytes + Number(expected.size) > LIMITS.bytes)
      throw new Error("source text inventory exceeds 4 MiB");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!sameFile(expected, opened)) throw new Error("source changed while opening");
      const buffer = Buffer.alloc(Number(opened.size) + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      const after = this.chain(root, path);
      if (
        offset !== Number(opened.size) ||
        !sameFile(opened, fstatSync(fd, { bigint: true })) ||
        before.some(
          ([entry, stat], i) => entry !== after[i]?.[0] || !sameIdentity(stat, after[i][1]),
        )
      ) {
        throw new Error("source changed while reading");
      }
      this.bytes += offset;
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
      } catch {
        throw new Error("selected text is not valid UTF-8");
      }
    } finally {
      closeSync(fd);
    }
  }

  /** Entries are streamed and bounded, including ignored files, before retaining names. */
  files(root: string, accept: (name: string) => boolean, depth = 0): string[] {
    if (depth > LIMITS.depth) throw new Error("source directory nesting exceeds 8 levels");
    const before = this.chain(root, root)[0][1];
    const dir = opendirSync(root);
    const entries: Array<{ name: string; directory: boolean }> = [];
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++this.entries > LIMITS.files) throw new Error("source inventory exceeds 256 entries");
        // Hidden directories and non-text assets are never followed/read/copied.
        if (entry.name.startsWith(".")) continue;
        if (entry.isSymbolicLink()) {
          if (accept(entry.name)) throw new Error("selected source inventory contains a symlink");
          continue;
        }
        entries.push({ name: entry.name, directory: entry.isDirectory() });
      }
    } finally {
      dir.closeSync();
    }
    if (!sameIdentity(before, lstatSync(root, { bigint: true })))
      throw new Error("source directory changed");
    const result: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(root, entry.name);
      if (entry.directory) {
        const child = this.chain(root, path).at(-1)![1];
        if (!child.isDirectory()) throw new Error("source directory changed");
        result.push(...this.files(path, accept, depth + 1));
      } else if (accept(entry.name)) result.push(path);
    }
    return result;
  }
}
