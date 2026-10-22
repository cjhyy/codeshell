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
import { createHubPanelBinding } from "./hub-binding.js";

export type PanelDirectoryAuthorizer = (
  app: InstalledPanelApp,
  projectPath: string,
  workspacePath: string,
) => Promise<void>;

/** Host-only proof that a workspace still belongs to the expected main project. */
export function createPanelDirectoryProjectScope(
  workspacePath: string,
  expectedProjectPath: string,
): { projectPath: string; assertCurrent(): void } {
  for (const path of [workspacePath, expectedProjectPath]) {
    if (!isAbsolute(path) || path.length > 32_768 || path.includes("\0"))
      throw new Error("Invalid Panel directory project scope");
  }
  const binding = createHubPanelBinding(workspacePath);
  binding.assertBinding();
  const projectPath = realpathSync(expectedProjectPath);
  const identity = lstatSync(projectPath, { bigint: true });
  if (
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    realpathSync(binding.bindingCwd) !== projectPath
  )
    throw new Error("Panel directory project scope is unavailable");
  const assertCurrent = () => {
    binding.assertBinding();
    const current = lstatSync(projectPath, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      realpathSync(expectedProjectPath) !== projectPath ||
      realpathSync(binding.bindingCwd) !== projectPath
    )
      throw new Error("Panel directory project scope changed");
  };
  assertCurrent();
  return { projectPath, assertCurrent };
}

export function desktopPanelDirectoryBookmarks(dataDir: string) {
  const scopes = new Map<string, ReturnType<typeof createPanelDirectoryProjectScope>>();
  return new PanelAppDirectoryBookmarks(join(dataDir, "panel-app-directory-bookmarks.json"), {
    legacyFiles: [join(dataDir, "panel-web-directory-bookmarks.json")],
    isLegacyProjectScope(expectedProjectPath, legacyProjectPath) {
      const key = JSON.stringify([expectedProjectPath, legacyProjectPath]);
      try {
        let scope = scopes.get(key);
        if (!scope) {
          scope = createPanelDirectoryProjectScope(legacyProjectPath, expectedProjectPath);
          if (scopes.size >= 64) scopes.delete(scopes.keys().next().value!);
          scopes.set(key, scope);
        }
        // Keep a failed proof frozen: replacing Git metadata must not silently
        // reauthorize this instance's previously verified worktree association.
        scope.assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
  });
}

/** The file mutex uses a sibling of its parent; keep both inside the data volume. */
export function hubPanelDirectoryBookmarks(dataDir: string) {
  return new PanelAppDirectoryBookmarks(join(dataDir, "panel-directories", "bookmarks.json"), {
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
  // Decimal strings preserve Windows file IDs beyond Number.MAX_SAFE_INTEGER.
  // A null pair revokes a v1 identity whose numeric precision was already lost.
  dev: string | null;
  ino: string | null;
  savedAt: number;
}

function parseBookmark(record: unknown, version: number): Bookmark {
  const invalid = () => {
    throw new Error("Invalid Panel directory bookmarks");
  };
  if (!record || typeof record !== "object" || Array.isArray(record)) return invalid();
  const item = record as Partial<Bookmark>;
  if (
    !(
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
      Number.isSafeInteger(item.savedAt)
    )
  )
    return invalid();
  let dev: string | null, ino: string | null;
  if (version === 1) {
    const legacy = record as { dev?: unknown; ino?: unknown };
    if (
      typeof legacy.dev !== "number" ||
      !Number.isInteger(legacy.dev) ||
      legacy.dev < 0 ||
      typeof legacy.ino !== "number" ||
      !Number.isInteger(legacy.ino) ||
      legacy.ino < 0
    )
      return invalid();
    // Never recover an authorization by rounding a file ID. Retain a tombstone
    // so this UUID cannot fall back to a different grant in the legacy file.
    if (!Number.isSafeInteger(legacy.dev) || !Number.isSafeInteger(legacy.ino)) {
      dev = ino = null;
    } else {
      dev = String(legacy.dev);
      ino = String(legacy.ino);
    }
  } else {
    const exact = (value: unknown): value is string =>
      typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value);
    if (!(item.dev === null && item.ino === null) && !(exact(item.dev) && exact(item.ino)))
      return invalid();
    dev = item.dev!;
    ino = item.ino!;
  }
  return { ...item, dev, ino } as Bookmark;
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
      (value.version !== 1 && value.version !== 2) ||
      !Array.isArray(value.bookmarks) ||
      value.bookmarks.length > MAX_RECORDS
    )
      throw new Error("Invalid Panel directory bookmarks");
    return value.bookmarks.map((record) => parseBookmark(record, value.version as number));
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
  const serialized = JSON.stringify({ version: 2, bookmarks });
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
    private readonly options: {
      legacyFiles?: readonly string[];
      /** Supplied only by a trusted Host, never by Panel or browser input. */
      isLegacyProjectScope?: (expectedProjectPath: string, legacyProjectPath: string) => boolean;
    } = {},
  ) {}

  remember(appId: string, projectPath: string, path: string): string {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(appId) || !isAbsolute(projectPath) || !isAbsolute(path))
      throw new Error("Invalid Panel directory bookmark scope");
    const info = lstatSync(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path)
      throw new Error("Selected directory changed; choose it again");
    const bookmark: Bookmark = {
      id: randomUUID(),
      appId,
      projectPath,
      path,
      dev: info.dev.toString(),
      ino: info.ino.toString(),
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
          item.dev === bookmark.dev &&
          item.ino === bookmark.ino,
      );
      if (existing) bookmark.id = existing.id;
      const retained = previous.filter(
        (item) =>
          item.id !== bookmark.id &&
          !(
            item.dev !== null &&
            item.appId === appId &&
            item.projectPath === projectPath &&
            item.path === path &&
            (item.dev !== bookmark.dev || item.ino !== bookmark.ino)
          ),
      );
      // Keep revocations even when the bounded store evicts older live grants:
      // forgetting one could resurrect that UUID through a legacy-file fallback.
      const revoked = retained.filter((item) => item.dev === null);
      if (revoked.length >= MAX_RECORDS) throw new Error("Panel directory bookmarks are full");
      write(
        this.file,
        [bookmark, ...revoked, ...retained.filter((item) => item.dev !== null)].slice(
          0,
          MAX_RECORDS,
        ),
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
    if (!bookmark || bookmark.appId !== appId)
      throw new Error("Saved directory is unavailable; choose it again");
    const savedProjectPath = bookmark.projectPath;
    const assertProjectScope = () => {
      if (savedProjectPath === projectPath) return;
      try {
        if (this.options.isLegacyProjectScope?.(projectPath, savedProjectPath) === true) return;
      } catch {
        // The Host proof is optional; a failed proof never relaxes exact scope.
      }
      throw new Error("Saved directory is unavailable; choose it again");
    };
    assertProjectScope();
    try {
      const info = lstatSync(bookmark.path, { bigint: true });
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.dev.toString() !== bookmark.dev ||
        info.ino.toString() !== bookmark.ino ||
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
    assertProjectScope();
    return bookmark.path;
  }
}
