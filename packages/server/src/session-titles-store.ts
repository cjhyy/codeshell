/** Durable UI-side session titles, keyed by canonical engine session id. */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireLockOnPath } from "@cjhyy/code-shell-core/internal";

interface TitleMap {
  [sessionId: string]: string;
}

const MAX_TITLE_ENTRIES = 20_000;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 1_024;
const MAX_TITLE_FILE_BYTES = 4 * 1024 * 1024;
const FORBIDDEN_MAP_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class SessionTitleConflictError extends Error {
  constructor() {
    super("Session title changed on another device");
    this.name = "SessionTitleConflictError";
  }
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

function parseTitleMap(value: unknown, strict = false): TitleMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (strict) throw new Error("session title registry is malformed");
    return Object.create(null) as TitleMap;
  }
  if (strict && Object.keys(value).length > MAX_TITLE_ENTRIES)
    throw new Error("session title registry contains too many entries");
  const result: TitleMap = Object.create(null) as TitleMap;
  for (const [id, title] of Object.entries(value).slice(0, MAX_TITLE_ENTRIES)) {
    if (!validSessionId(id) || !validTitle(title)) {
      if (strict) throw new Error("session title registry contains malformed entries");
      continue;
    }
    if (strict || title) result[id] = title;
  }
  return result;
}

function load(target: string, strict = false): TitleMap {
  let descriptor: number | undefined;
  try {
    const entry = fs.lstatSync(target);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_TITLE_FILE_BYTES)
      throw new Error("session title registry must be a bounded regular file");
    descriptor = fs.openSync(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_TITLE_FILE_BYTES)
      throw new Error("session title registry must be a bounded regular file");
    // A concurrent append must not turn a checked four-megabyte file into an
    // unbounded allocation. Read at most the limit plus one sentinel byte.
    const buffer = Buffer.alloc(Math.min(opened.size + 1, MAX_TITLE_FILE_BYTES + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytes, buffer.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    if (bytes > opened.size || bytes > MAX_TITLE_FILE_BYTES)
      throw new Error("session title registry changed during read");
    return parseTitleMap(JSON.parse(buffer.subarray(0, bytes).toString("utf8")), strict);
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return Object.create(null) as TitleMap;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function save(target: string, map: TitleMap): void {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentInfo = fs.lstatSync(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory())
      throw new Error("session title directory must be a real directory");
    try {
      const targetInfo = fs.lstatSync(target);
      if (targetInfo.isSymbolicLink() || !targetInfo.isFile())
        throw new Error("session title target must be a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const serialized = `${JSON.stringify(map, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_TITLE_FILE_BYTES)
      throw new Error("session title registry is too large");
    fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* preserve the original write error */
    }
  }
}

/** Independent host stores share the same atomic title persistence and cross-process lock. */
export function createSessionTitlesStore(
  file: string,
  options: { strictMutations?: boolean } = {},
) {
  let mutationQueue: Promise<void> = Promise.resolve();
  function serializeMutation(mutation: (target: string) => void): Promise<void> {
    const target = file;
    const result = mutationQueue.then(() => mutation(target));
    mutationQueue = result.catch(() => undefined);
    return result;
  }

  async function listTitles(): Promise<TitleMap> {
    await mutationQueue.catch(() => undefined);
    return load(file);
  }

  function setTitle(
    id: string,
    title: string,
    expected: { expectedTitle?: string | null } = {},
  ): Promise<void> {
    if (!validSessionId(id)) throw new Error("invalid session id");
    if (!validTitle(title)) throw new Error("invalid session title");
    if (
      expected.expectedTitle !== undefined &&
      expected.expectedTitle !== null &&
      !validTitle(expected.expectedTitle)
    )
      throw new Error("invalid expected session title");
    return serializeMutation((target) => {
      const parent = path.dirname(target);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      const parentInfo = fs.lstatSync(parent);
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
        throw new Error("session title directory must be a real directory");
      }
      // A volume root such as /data is writable while its parent / is not.
      // Keep both the lock anchor and its sibling lock inside that volume.
      const anchor = path.join(parent, `.${path.basename(target)}.mutex`);
      fs.mkdirSync(anchor, { recursive: true, mode: 0o700 });
      const anchorInfo = fs.lstatSync(anchor);
      if (!anchorInfo.isDirectory() || anchorInfo.isSymbolicLink())
        throw new Error("session title lock anchor must be a real directory");
      // No await inside this synchronous cross-process lock: a second store
      // instance must never block the event loop while this holder waits for I/O.
      const release = acquireLockOnPath(anchor);
      try {
        const map = load(target, options.strictMutations);
        if (
          expected.expectedTitle !== undefined &&
          (map[id] ?? "") !== (expected.expectedTitle ?? "")
        )
          throw new SessionTitleConflictError();
        if (title) {
          if (!(id in map) && Object.keys(map).length >= MAX_TITLE_ENTRIES) {
            throw new Error("session title registry is full");
          }
          map[id] = title;
        } else delete map[id];
        save(target, map);
      } finally {
        release();
      }
    });
  }

  return { listTitles, setTitle };
}
