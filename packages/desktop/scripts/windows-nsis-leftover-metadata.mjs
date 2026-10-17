/** One metadata-only observation after the existing uninstall absence gate fails.
 * No process authority, file contents, link targets, recursion or compensating cleanup. */
import { lstat, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

export const NSIS_LEFTOVER_LIMITS = Object.freeze({
  entries: 128,
  bytes: 64 * 1024,
  softDeadlineMs: 2_000,
});

const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameDirectory = (a, b) =>
  sameIdentity(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const typeOf = (info) =>
  info.isSymbolicLink()
    ? "link"
    : info.isDirectory()
      ? "directory"
      : info.isFile()
        ? "file"
        : "other";

/** Caller retains the original failure before awaiting this nonthrowing leaf.
 * The deadline is soft: all pending FS operations and directory close are awaited. */
export async function observeNsisUninstallLeftovers(
  { root, installation },
  { io = { lstat, opendir, realpath }, now = () => performance.now() } = {},
) {
  const result = {
    schemaVersion: 1,
    trigger: "post-uninstall-absence-failure",
    scope: "exact-owned-installation-direct-children",
    status: "unknown",
    rootType: "unknown",
    complete: false,
    entries: [],
    reason: "filesystem",
    limits: NSIS_LEFTOVER_LIMITS,
    elapsedMs: 0,
    boundary:
      "One read-only metadata observation; no file bytes/link targets/recursion. Soft deadline awaits pending IO and close. Not a kernel race sandbox or uninstall success.",
  };
  let started, directory, reason;
  const refuse = (value) => {
    reason = value;
    throw Error("Owned leftover metadata observation unavailable");
  };
  const checkTime = () => {
    const elapsed = now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0) refuse("clock");
    result.elapsedMs = elapsed;
    if (elapsed > NSIS_LEFTOVER_LIMITS.softDeadlineMs) refuse("soft-deadline");
  };
  const read = async (operation) => {
    const value = await operation();
    checkTime();
    return value;
  };
  try {
    started = now();
    if (
      typeof root !== "string" ||
      typeof installation !== "string" ||
      root !== resolve(root) ||
      installation !== join(root, "code-shell")
    )
      refuse("owned-path");
    checkTime();
    const parents = [];
    for (let parent = root; ; parent = dirname(parent)) {
      const info = await read(() => io.lstat(parent, { bigint: true }));
      if (typeOf(info) !== "directory") refuse("parent-alias");
      parents.push({ path: parent, info });
      if (parent === dirname(parent)) break;
    }
    if (!samePath(await read(() => io.realpath(root)), root)) refuse("parent-alias");
    const before = await read(() => io.lstat(installation, { bigint: true }));
    result.rootType = typeOf(before);
    if (result.rootType !== "directory") refuse("root-not-directory");
    if (!samePath(await read(() => io.realpath(installation)), installation)) refuse("root-alias");
    // Assign before checking time so a slow successful opendir is still closed.
    directory = await io.opendir(installation);
    checkTime();
    if (!sameDirectory(before, await read(() => io.lstat(installation, { bigint: true }))))
      refuse("identity-changed");
    while (true) {
      const entry = await read(() => directory.read());
      if (!entry) break;
      if (result.entries.length === NSIS_LEFTOVER_LIMITS.entries) refuse("entry-limit");
      const name = entry.name;
      if (
        typeof name !== "string" ||
        !name ||
        name.length > 1_024 ||
        name === "." ||
        name === ".." ||
        isAbsolute(name) ||
        /[\\/\0:]/.test(name) ||
        name.endsWith(".") ||
        name.endsWith(" ") ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
        join(installation, name) !== installation + sep + name
      )
        refuse("unsafe-name");
      const info = await read(() => io.lstat(join(installation, name), { bigint: true }));
      const row = { relativeName: name, type: typeOf(info) };
      if (row.type === "file") {
        if (info.size < 0n || info.size > BigInt(Number.MAX_SAFE_INTEGER)) refuse("metadata");
        row.size = Number(info.size);
      }
      // Include the unknown envelope when measuring; the final reason is bounded.
      const candidate = {
        ...result,
        entries: [...result.entries, row],
        reason: "identity-changed",
      };
      if (Buffer.byteLength(JSON.stringify(candidate)) > NSIS_LEFTOVER_LIMITS.bytes - 256)
        refuse("byte-limit");
      result.entries.push(row);
    }
    if (!sameDirectory(before, await read(() => io.lstat(installation, { bigint: true }))))
      refuse("identity-changed");
    if (!samePath(await read(() => io.realpath(installation)), installation)) refuse("root-alias");
    for (const parent of parents) {
      const after = await read(() => io.lstat(parent.path, { bigint: true }));
      if (typeOf(after) !== "directory" || !sameIdentity(parent.info, after))
        refuse("identity-changed");
    }
    result.status = "observed";
    result.complete = true;
    result.reason = "none";
  } catch {
    result.reason = reason ?? "filesystem";
  } finally {
    if (directory) {
      try {
        await directory.close();
        checkTime();
      } catch {
        result.status = "unknown";
        result.complete = false;
        result.reason = reason ?? "close";
      }
    }
    if (result.status !== "observed") result.complete = false;
    result.entries.sort((a, b) =>
      a.relativeName < b.relativeName ? -1 : a.relativeName > b.relativeName ? 1 : 0,
    );
  }
  return result;
}
