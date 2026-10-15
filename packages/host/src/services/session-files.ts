import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { sessionsRoot } from "@cjhyy/code-shell-core";

export class SessionFileError extends Error {
  constructor(
    readonly code: "invalid_path" | "forbidden" | "too_large" | "changed",
    message: string,
    readonly subject?: "directory" | "file",
  ) {
    super(message);
  }
}

export function assertSessionFileId(id: string): void {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id) || id === "." || id.includes(".."))
    throw new SessionFileError("invalid_path", "Invalid session id");
}

function paths(root: string, id: string, leaf: string) {
  assertSessionFileId(id);
  if (
    !isAbsolute(root) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(leaf) ||
    leaf === "." ||
    leaf.includes("..")
  )
    throw new SessionFileError(
      "invalid_path",
      "Session files require an absolute root and a direct filename",
    );
  return { directory: join(root, id), file: join(root, id, leaf) };
}

function directory(info: fs.Stats): fs.Stats {
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new SessionFileError("forbidden", "Session directory is not ordinary");
  return info;
}
function ordinary(info: fs.Stats, limit: number): fs.Stats {
  if (!info.isFile() || info.isSymbolicLink())
    throw new SessionFileError("forbidden", "Session record is not an ordinary file");
  if (!Number.isSafeInteger(limit) || limit < 0 || info.size > limit)
    throw new SessionFileError("too_large", "Session record exceeds the read limit");
  return info;
}
function same(
  before: fs.Stats,
  after: fs.Stats,
  subject: "directory" | "file" = "directory",
): void {
  if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino)
    throw new SessionFileError("changed", "Session storage changed during read", subject);
}
const directoryFlags =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0);
const fileFlags =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

function withFileSync<T>(
  root: string,
  id: string,
  leaf: string,
  limit: number,
  read: (fd: number, info: fs.Stats) => T,
): T {
  const path = paths(root, id, leaf);
  const before = directory(fs.lstatSync(path.directory));
  let dir: number | undefined, file: number | undefined;
  try {
    dir = fs.openSync(path.directory, directoryFlags);
    same(before, fs.fstatSync(dir));
    file = fs.openSync(
      process.platform === "linux" ? `/proc/self/fd/${dir}/${leaf}` : path.file,
      fileFlags,
    );
    const info = ordinary(fs.fstatSync(file), limit);
    const value = read(file, info);
    same(before, fs.lstatSync(path.directory));
    same(info, fs.lstatSync(path.file), "file");
    return value;
  } finally {
    try {
      if (file !== undefined) fs.closeSync(file);
    } finally {
      if (dir !== undefined) fs.closeSync(dir);
    }
  }
}

export function readSessionFileSync(
  root: string,
  id: string,
  leaf: string,
  maximumBytes: number,
): string {
  return withFileSync(root, id, leaf, maximumBytes, (fd, info) => {
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const bytes = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!bytes) break;
      offset += bytes;
    }
    return data.subarray(0, offset).toString("utf8");
  });
}

/** Lists tolerate at most two ordinary-file atomic replacements, never directory changes. */
export function readSessionListStateSync(root: string, id: string, maximumBytes: number): string {
  const path = paths(root, id, "state.json");
  const anchor = directory(fs.lstatSync(path.directory));
  const fd = fs.openSync(path.directory, directoryFlags);
  try {
    same(anchor, fs.fstatSync(fd));
    for (let attempt = 0; ; attempt++) {
      try {
        const value = readSessionFileSync(root, id, "state.json", maximumBytes);
        same(anchor, fs.lstatSync(path.directory));
        return value;
      } catch (error) {
        if (
          !(error instanceof SessionFileError) ||
          error.code !== "changed" ||
          error.subject !== "file"
        )
          throw error;
        same(anchor, fs.lstatSync(path.directory));
        ordinary(fs.lstatSync(path.file), maximumBytes);
        if (attempt >= 2) throw error;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

export async function readSessionListState(
  root: string,
  id: string,
  maximumBytes: number,
): Promise<string> {
  const path = paths(root, id, "state.json");
  const anchor = directory(await fsp.lstat(path.directory));
  const handle = await fsp.open(path.directory, directoryFlags);
  try {
    same(anchor, await handle.stat());
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await readSessionFile(root, id, "state.json", maximumBytes);
        same(anchor, await fsp.lstat(path.directory));
        return value;
      } catch (error) {
        if (
          !(error instanceof SessionFileError) ||
          error.code !== "changed" ||
          error.subject !== "file"
        )
          throw error;
        same(anchor, await fsp.lstat(path.directory));
        ordinary(await fsp.lstat(path.file), maximumBytes);
        if (attempt >= 2) throw error;
      }
    }
  } finally {
    await handle.close();
  }
}

export function statSessionFileSync(
  root: string,
  id: string,
  leaf: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): fs.Stats {
  return withFileSync(root, id, leaf, maximumBytes, (_fd, info) => info);
}

/** Async counterpart for Electron main; never blocks its event loop on disk reads. */
export async function readSessionFile(
  root: string,
  id: string,
  leaf: string,
  maximumBytes: number,
): Promise<string> {
  const path = paths(root, id, leaf);
  const before = directory(await fsp.lstat(path.directory));
  let dir: fsp.FileHandle | undefined, file: fsp.FileHandle | undefined;
  try {
    dir = await fsp.open(path.directory, directoryFlags);
    same(before, await dir.stat());
    file = await fsp.open(
      process.platform === "linux" ? `/proc/self/fd/${dir.fd}/${leaf}` : path.file,
      fileFlags,
    );
    const info = ordinary(await file.stat(), maximumBytes);
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    same(before, await fsp.lstat(path.directory));
    same(info, await fsp.lstat(path.file), "file");
    return data.subarray(0, offset).toString("utf8");
  } finally {
    try {
      await file?.close();
    } finally {
      await dir?.close();
    }
  }
}

export function scanSessionDirectoriesSync(
  root = resolve(sessionsRoot()),
): { id: string; mtime: number }[] {
  if (!isAbsolute(root))
    throw new SessionFileError("invalid_path", "Session root must be absolute");
  try {
    return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      try {
        if (!entry.isDirectory()) return [];
        assertSessionFileId(entry.name);
        const info = directory(fs.lstatSync(join(root, entry.name)));
        return [{ id: entry.name, mtime: info.mtimeMs }];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function scanSessionDirectories(
  root = resolve(sessionsRoot()),
): Promise<{ id: string; mtime: number }[]> {
  if (!isAbsolute(root))
    throw new SessionFileError("invalid_path", "Session root must be absolute");
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const candidates = await Promise.all(
      entries.map(async (entry) => {
        try {
          if (!entry.isDirectory()) return [];
          assertSessionFileId(entry.name);
          const info = directory(await fsp.lstat(join(root, entry.name)));
          return [{ id: entry.name, mtime: info.mtimeMs }];
        } catch {
          return [];
        }
      }),
    );
    return candidates.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Only filesystem custody. Core retains activity ordering, filters, cursor and tail previews. */
export function sessionListStorage(root: string) {
  return {
    candidates: () =>
      scanSessionDirectoriesSync(root).flatMap(({ id }) => {
        if (id.startsWith(".pending-") || id.startsWith("qchat-")) return [];
        try {
          const state = ordinary(fs.lstatSync(join(root, id, "state.json")), 1024 * 1024);
          let transcript: fs.Stats | undefined;
          try {
            transcript = ordinary(
              fs.lstatSync(join(root, id, "transcript.jsonl")),
              Number.MAX_SAFE_INTEGER,
            );
          } catch (error) {
            if (
              !["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
            )
              throw error;
          }
          return [
            {
              dir: id,
              lastActiveAt: transcript?.mtimeMs ?? state.mtimeMs,
              transcriptExists: !!transcript,
            },
          ];
        } catch {
          return [];
        }
      }),
    readState: (id: string, maximumBytes: number) =>
      readSessionListStateSync(root, id, maximumBytes),
  };
}
