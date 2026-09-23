import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { InstalledPanelApp } from "@cjhyy/code-shell-core";
import { dirname, isAbsolute, join } from "node:path";
import { acquireFileLock } from "@cjhyy/code-shell-core/internal";

export type PanelDirectoryAuthorizer = (
  app: InstalledPanelApp,
  projectPath: string,
  workspacePath: string,
) => Promise<void>;

export function desktopPanelDirectoryBookmarks(dataDir: string) {
  return new PanelAppDirectoryBookmarks(join(dataDir, "panel-app-directory-bookmarks.json"), {
    legacyFiles: [join(dataDir, "panel-web-directory-bookmarks.json")],
  });
}

const MAX_RECORDS = 256;
const MAX_BYTES = 256 * 1024;
const ID = /^[a-f0-9-]{36}$/i;

interface Bookmark {
  id: string;
  appId: string;
  projectPath: string;
  path: string;
  dev: number;
  ino: number;
  savedAt: number;
}

function valid(record: unknown): record is Bookmark {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const item = record as Partial<Bookmark>;
  return (
    typeof item.id === "string" &&
    ID.test(item.id) &&
    typeof item.appId === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/.test(item.appId) &&
    typeof item.projectPath === "string" &&
    isAbsolute(item.projectPath) &&
    typeof item.path === "string" &&
    isAbsolute(item.path) &&
    item.path.length <= 32_768 &&
    item.projectPath.length <= 32_768 &&
    Number.isSafeInteger(item.dev) &&
    Number.isSafeInteger(item.ino) &&
    Number.isSafeInteger(item.savedAt)
  );
}

function read(file: string): Bookmark[] {
  let fd: number | undefined;
  try {
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_BYTES)
      throw new Error("Panel directory bookmarks are not a bounded regular file");
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_BYTES)
      throw new Error("Panel directory bookmarks are not a bounded regular file");
    const document = JSON.parse(readFileSync(fd, "utf8")) as unknown;
    if (!document || typeof document !== "object" || Array.isArray(document))
      throw new Error("Invalid Panel directory bookmarks");
    const value = document as { version?: unknown; bookmarks?: unknown };
    if (
      value.version !== 1 ||
      !Array.isArray(value.bookmarks) ||
      value.bookmarks.length > MAX_RECORDS ||
      !value.bookmarks.every(valid)
    )
      throw new Error("Invalid Panel directory bookmarks");
    return value.bookmarks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function write(file: string, bookmarks: Bookmark[]): void {
  const parent = dirname(file);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = lstatSync(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Invalid Panel bookmark directory");
  try {
    const existing = lstatSync(file);
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error("Invalid Panel bookmark file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const serialized = JSON.stringify({ version: 1, bookmarks });
  if (Buffer.byteLength(serialized) > MAX_BYTES)
    throw new Error("Panel directory bookmarks are full");
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    if (process.platform !== "win32") chmodSync(file, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** The guest receives only a random bookmark. A path saved in guest storage grants nothing. */
export class PanelAppDirectoryBookmarks {
  constructor(
    private readonly file: string,
    private readonly options: { legacyFiles?: readonly string[] } = {},
  ) {}

  remember(appId: string, projectPath: string, path: string): string {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(appId) || !isAbsolute(projectPath) || !isAbsolute(path))
      throw new Error("Invalid Panel directory bookmark scope");
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path)
      throw new Error("Selected directory changed; choose it again");
    const bookmark: Bookmark = {
      id: randomUUID(),
      appId,
      projectPath,
      path,
      dev: info.dev,
      ino: info.ino,
      savedAt: Date.now(),
    };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const release = acquireFileLock(this.file);
    try {
      const previous = read(this.file);
      const existing = previous.find(
        (item) =>
          item.appId === appId &&
          item.projectPath === projectPath &&
          item.path === path &&
          item.dev === info.dev &&
          item.ino === info.ino,
      );
      if (existing) bookmark.id = existing.id;
      write(
        this.file,
        [
          bookmark,
          ...previous.filter(
            (item) =>
              item.id !== bookmark.id &&
              !(
                item.appId === appId &&
                item.projectPath === projectPath &&
                item.path === path &&
                (item.dev !== info.dev || item.ino !== info.ino)
              ),
          ),
        ].slice(0, MAX_RECORDS),
      );
    } finally {
      release();
    }
    return bookmark.id;
  }

  restore(appId: string, projectPath: string, id: unknown): string {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid directory bookmark");
    let bookmark = read(this.file).find((item) => item.id === id);
    let legacy = false;
    if (!bookmark) {
      for (const file of this.options.legacyFiles ?? []) {
        bookmark = read(file).find((item) => item.id === id);
        if (bookmark) {
          legacy = true;
          break;
        }
      }
    }
    if (!bookmark || bookmark.appId !== appId || bookmark.projectPath !== projectPath)
      throw new Error("Saved directory is unavailable; choose it again");
    try {
      const info = lstatSync(bookmark.path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.dev !== bookmark.dev ||
        info.ino !== bookmark.ino ||
        realpathSync(bookmark.path) !== bookmark.path
      )
        throw new Error("Saved directory changed");
    } catch {
      throw new Error("Saved directory changed; choose it again");
    }
    if (legacy) {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const release = acquireFileLock(this.file);
      try {
        const previous = read(this.file);
        const existing = previous.find((item) => item.id === id);
        if (
          existing &&
          (existing.appId !== bookmark.appId ||
            existing.projectPath !== bookmark.projectPath ||
            existing.path !== bookmark.path ||
            existing.dev !== bookmark.dev ||
            existing.ino !== bookmark.ino)
        )
          throw new Error("Saved directory identity conflicts with the current grant");
        if (!existing) {
          // Migration never silently evicts another live bookmark. Preserve legacy
          // IDs as aliases when both interfaces previously selected the same path.
          if (previous.length >= MAX_RECORDS) throw new Error("Panel directory bookmarks are full");
          write(this.file, [bookmark, ...previous]);
        }
      } finally {
        release();
      }
    }
    return bookmark.path;
  }
}
