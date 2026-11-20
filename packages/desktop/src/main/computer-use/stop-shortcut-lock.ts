/**
 * Which CodeShell instance owns the ⌘⇧Esc stop shortcut for this user.
 *
 * On macOS, Electron's `globalShortcut.register` returns true in a second
 * process that registers an accelerator another process already holds, and
 * only one of them actually receives the key. Instances therefore claim the
 * shortcut through a small per-user owner file (pid + process start time); an
 * instance that finds a live owner treats the shortcut as unavailable.
 *
 * Read-check-write runs under the shared async lockfile helper, so two
 * instances never both claim it and the Electron main thread never waits
 * synchronously. A claim whose owner is gone, or whose pid now belongs to a
 * different process (start time differs), is stale and is taken over.
 */
import { execFile } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { lock } from "@cjhyy/code-shell-core/internal";

export interface StopShortcutOwner {
  pid: number;
  /** Wall-clock start of the owner's process, in ms. */
  startedAt: number;
}

export interface StopShortcutLock {
  /** True when this instance holds the claim afterwards. */
  acquire(): Promise<boolean>;
  release(): Promise<void>;
  /** For process exit, where nothing asynchronous runs any more. */
  releaseSync(): void;
}

export type StopShortcutNamespace = "native" | "virtual";

/** Same-pid owners whose start times differ by more than this are different processes. */
const START_TOLERANCE_MS = 10_000;
// Taken once, early: process.uptime() does not advance while a Mac sleeps.
const STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

export function processStartedAt(): number {
  return STARTED_AT;
}

/**
 * Per-user claim file. Acceptance runs (virtual shortcut) use their own
 * namespace, so they never make a real instance give up the key.
 */
export function stopShortcutLockFile(
  namespace: StopShortcutNamespace,
  directory = join(tmpdir(), `code-shell-${userInfo().uid}`),
): string {
  return join(
    directory,
    namespace === "native" ? "stop-shortcut.owner.json" : "stop-shortcut.e2e-virtual.owner.json",
  );
}

/** `ps -o etime` is `[[dd-]hh:]mm:ss`; undefined when it cannot be read. */
function elapsedSeconds(text: string): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
  );
}

/** The owner's pid exists and, when `ps` can tell, started when the claim says. */
export async function stopShortcutOwnerAlive(owner: StopShortcutOwner): Promise<boolean> {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const elapsed = await new Promise<number | undefined>((resolve) =>
    execFile(
      "/bin/ps",
      ["-o", "etime=", "-p", String(owner.pid)],
      { timeout: 5_000 },
      (error, out) => resolve(error ? undefined : elapsedSeconds(String(out))),
    ),
  );
  if (elapsed === undefined) return true;
  return Math.abs(Date.now() - elapsed * 1000 - owner.startedAt) <= START_TOLERANCE_MS;
}

function parseOwner(raw: string): StopShortcutOwner | undefined {
  try {
    const value = JSON.parse(raw) as Partial<StopShortcutOwner>;
    if (Number.isSafeInteger(value.pid) && Number.isFinite(value.startedAt))
      return { pid: value.pid!, startedAt: value.startedAt! };
  } catch {
    /* unreadable: not an owner */
  }
  return undefined;
}

export function createStopShortcutLock(options: {
  file: string;
  pid?: number;
  startedAt?: number;
  isAlive?: (owner: StopShortcutOwner) => Promise<boolean>;
}): StopShortcutLock {
  const self: StopShortcutOwner = {
    pid: options.pid ?? process.pid,
    startedAt: options.startedAt ?? STARTED_AT,
  };
  const isAlive = options.isAlive ?? stopShortcutOwnerAlive;
  const isSelf = (owner: StopShortcutOwner | undefined) =>
    owner?.pid === self.pid && owner.startedAt === self.startedAt;
  const current = async () => parseOwner(await readFile(options.file, "utf8").catch(() => ""));

  return {
    async acquire() {
      await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
      const unlock = await lock(options.file, {
        realpath: false,
        lockfilePath: `${options.file}.mutex`,
        stale: 10_000,
        retries: { retries: 40, minTimeout: 5, maxTimeout: 50 },
        // The critical section is a read and a rename; a lost lease needs no action.
        onCompromised: () => undefined,
      });
      try {
        const owner = await current();
        if (isSelf(owner)) return true;
        if (owner && (await isAlive(owner))) return false;
        const staged = `${options.file}.${self.pid}.tmp`;
        await writeFile(staged, JSON.stringify(self), { mode: 0o600 });
        await rename(staged, options.file);
        return true;
      } finally {
        await unlock();
      }
    },
    // A live owner's claim is never overwritten by anyone else, so comparing
    // and removing needs no mutex.
    async release() {
      if (isSelf(await current())) await unlink(options.file).catch(() => undefined);
    },
    releaseSync() {
      try {
        if (isSelf(parseOwner(readFileSync(options.file, "utf8")))) unlinkSync(options.file);
      } catch {
        /* already gone */
      }
    },
  };
}
