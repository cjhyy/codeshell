/** Durable UI-side session titles, keyed by canonical engine session id. */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { codeShellHome } from "@cjhyy/code-shell-core";
import { acquireFileLock } from "@cjhyy/code-shell-core/internal";

interface TitleMap {
  [sessionId: string]: string;
}

const MAX_TITLE_ENTRIES = 20_000;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 1_024;
const MAX_TITLE_FILE_BYTES = 4 * 1024 * 1024;
const FORBIDDEN_MAP_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function defaultFile(): string {
  return path.join(codeShellHome(), "desktop", "session-titles.json");
}

let file = defaultFile();
let mutationQueue: Promise<void> = Promise.resolve();

/** Test-only isolation hook. */
export function __setSessionTitlesFileForTest(next: string | null): void {
  file = next ?? defaultFile();
  mutationQueue = Promise.resolve();
}

function validSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LENGTH &&
    !FORBIDDEN_MAP_KEYS.has(value) &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function validTitle(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TITLE_LENGTH && !value.includes("\0");
}

function parseTitleMap(value: unknown): TitleMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: TitleMap = {};
  for (const [id, title] of Object.entries(value).slice(0, MAX_TITLE_ENTRIES)) {
    if (validSessionId(id) && validTitle(title) && title) result[id] = title;
  }
  return result;
}

async function load(target = file): Promise<TitleMap> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const entry = await fs.lstat(target);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_TITLE_FILE_BYTES) return {};
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_TITLE_FILE_BYTES) return {};
    return parseTitleMap(JSON.parse(await handle.readFile("utf8")) as unknown);
  } catch {
    return {};
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function save(target: string, map: TitleMap): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const parent = path.dirname(target);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const parentInfo = await fs.lstat(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new Error("session title directory must be a real directory");
    }
    try {
      const targetInfo = await fs.lstat(target);
      if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
        throw new Error("session title target must be a regular file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const serialized = `${JSON.stringify(map, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_TITLE_FILE_BYTES) {
      throw new Error("session title registry is too large");
    }
    await fs.writeFile(temporary, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function serializeMutation(mutation: (target: string) => Promise<void>): Promise<void> {
  const target = file;
  const result = mutationQueue.then(() => mutation(target));
  mutationQueue = result.catch(() => undefined);
  return result;
}

export async function listTitles(): Promise<TitleMap> {
  await mutationQueue.catch(() => undefined);
  return load();
}

export function setTitle(id: string, title: string): Promise<void> {
  if (!validSessionId(id)) throw new Error("invalid session id");
  if (!validTitle(title)) throw new Error("invalid session title");
  return serializeMutation(async (target) => {
    const parent = path.dirname(target);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const parentInfo = await fs.lstat(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new Error("session title directory must be a real directory");
    }
    const release = acquireFileLock(target);
    try {
      const map = await load(target);
      if (title) {
        if (!(id in map) && Object.keys(map).length >= MAX_TITLE_ENTRIES) {
          throw new Error("session title registry is full");
        }
        map[id] = title;
      } else delete map[id];
      await save(target, map);
    } finally {
      release();
    }
  });
}
