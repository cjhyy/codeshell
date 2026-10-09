/** Private-fixture adapter for proper-lockfile's public callback fs option. Not kernel custody. */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { LOCK_STALE_MS } from "./io.js";

type Callback<T = void> = (error: NodeJS.ErrnoException | null, value?: T) => void;
type Phase = "acquiring" | "active" | "draining" | "releasing" | "closed";
type Identity = { dev: number; ino: number };

/** Explicit test instrumentation: an awaited completion gate is not natural filesystem latency. */
export type FixtureIOHooks = {
  /** Source fault injection before a named syscall. Never evidence of natural OS failure. */
  faultBefore?: (operation: string) => Error | undefined;
  afterNative?: (operation: string) => void | Promise<void>;
  observe?: (event: Readonly<{ operation: string; stage: "submit" | "settle" }>) => void;
};

function error(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}
function same(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * All prototypes on this module instance reserve the canonical state path until cleanup settles.
 * A direct call to an older lock API bypasses this registry and is unsupported on the shared path.
 */
const reservations = new Set<string>();
const compromised = new Map<string, unknown>();
export function combineFailures(causes: readonly unknown[]): unknown {
  const unique = [...new Set(causes)];
  if (unique.length === 1) return unique[0];
  return new AggregateError(
    unique,
    unique.map((cause) => (cause instanceof Error ? cause.message : String(cause))).join("; "),
    { cause: unique[0] },
  );
}
export function reservePath(path: string): boolean {
  if (compromised.has(path)) throw compromised.get(path);
  if (reservations.has(path)) return false;
  reservations.add(path);
  return true;
}
export function releasePath(path: string): void {
  reservations.delete(path);
}
export function poisonPath(path: string, cause: unknown): void {
  if (!compromised.has(path)) compromised.set(path, cause);
}
export function assertPath(path: string): void {
  if (compromised.has(path)) throw compromised.get(path);
}

export class LeaseFs {
  readonly path: string;
  // Must stay extensible: proper-lockfile's precision probe installs a private Symbol cache.
  readonly api: object;
  private phase: Phase = "acquiring";
  private pending = 0;
  private callbackDepth = 0;
  private waiters: Array<() => void> = [];
  private handle?: FileHandle;
  private owned?: Identity;
  private candidate?: fs.Stats;
  private created = false;
  private cleanupFailures: unknown[] = [];
  private cleanup?: Promise<void>;

  constructor(
    readonly target: string,
    private readonly onFailure: (cause: unknown) => void,
    private readonly hooks: FixtureIOHooks = {},
  ) {
    this.path = `${target}.lock`;
    this.api = {
      mkdir: (path: string, callback: Callback) => this.mkdir(path, callback),
      stat: (path: string, callback: Callback<fs.Stats>) => this.stat(path, callback),
      utimes: (path: string, atime: fs.TimeLike, mtime: fs.TimeLike, callback: Callback) =>
        this.utimes(path, atime, mtime, callback),
      rmdir: (path: string, callback: Callback) => this.rmdir(path, callback),
      rmdirSync: (path: string) => this.exitRemove(path),
    };
  }

  snapshot(): Readonly<{
    phase: Phase;
    pending: number;
    descriptorOpen: boolean;
    created: boolean;
  }> {
    return Object.freeze({
      phase: this.phase,
      pending: this.pending,
      descriptorOpen: !!this.handle,
      created: this.created,
    });
  }

  activate(): void {
    if (!this.handle || !this.owned || this.phase !== "acquiring")
      throw this.broken("Lock grant has no owned directory descriptor");
    this.phase = "active";
  }

  async assertOwned(): Promise<void> {
    if (this.phase !== "active" || !this.handle || !this.owned)
      throw this.broken("Current owned lock descriptor required");
    await this.named(this.owned);
    if (!same(await this.handle.stat(), this.owned))
      throw this.broken("Owned lock descriptor incarnation changed");
  }

  private broken(message: string): NodeJS.ErrnoException {
    const cause = error("ECOMPROMISED", message);
    this.cleanupFailures.push(cause);
    this.onFailure(cause);
    return cause;
  }

  private checkPath(path: string): void {
    if (path !== this.path) throw this.broken("Lock adapter received an unrelated path");
  }

  private dispatch<T>(
    operation: string,
    callback: Callback<T>,
    run: () => Promise<T>,
    cleanup = false,
  ): void {
    const admitted =
      this.phase !== "closed" &&
      (cleanup ||
        this.phase === "acquiring" ||
        this.phase === "active" ||
        (this.phase === "draining" && this.callbackDepth > 0));
    this.pending++;
    // Count through callback return: a callback can synchronously submit its utimes descendant.
    void Promise.resolve()
      .then(async () => {
        this.hooks.observe?.({ operation, stage: "submit" });
        if (!admitted) throw error("EBUSY", "Lock adapter is closing");
        const value = await run();
        await this.hooks.afterNative?.(operation);
        return value;
      })
      .then(
        (value) => this.deliver(callback, null, value),
        (cause) => {
          if (cause instanceof Error) return this.deliver(callback, cause);
          // Node callbacks use a truthy error to distinguish failure from success. Keep the
          // original thrown value in custody evidence, including undefined, null and false.
          this.cleanupFailures.push(cause);
          this.onFailure(cause);
          this.deliver(
            callback,
            Object.assign(new Error("Lock adapter rejected a non-Error value", { cause }), {
              code: "EIO",
            }),
          );
        },
      );
  }

  private deliver<T>(callback: Callback<T>, cause: NodeJS.ErrnoException | null, value?: T): void {
    this.callbackDepth++;
    try {
      callback(cause, value);
    } catch (caught) {
      this.cleanupFailures.push(caught);
      this.onFailure(caught);
    } finally {
      this.callbackDepth--;
      this.pending--;
      try {
        this.hooks.observe?.({ operation: "callback", stage: "settle" });
      } catch (caught) {
        this.cleanupFailures.push(caught);
        this.onFailure(caught);
      }
      if (this.pending === 0) for (const wake of this.waiters.splice(0)) wake();
    }
  }

  private async named(identity: Identity, owned = true): Promise<fs.Stats> {
    let stat: fs.Stats;
    try {
      stat = await fsp.lstat(this.path);
    } catch (cause) {
      if (owned) throw this.broken("Owned lock directory disappeared or became unreadable");
      throw cause;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(stat, identity))
      throw owned
        ? this.broken("Lock directory incarnation changed")
        : error("ELOCKED", "Observed stale lock directory changed");
    return stat;
  }

  private mkdir(path: string, callback: Callback): void {
    this.dispatch("lock.mkdir", callback, async () => {
      this.checkPath(path);
      await fsp.mkdir(path);
      this.created = true;
      // Capture the newly created name even if opening it subsequently fails.
      const named = await fsp.lstat(path);
      if (!named.isDirectory() || named.isSymbolicLink())
        throw this.broken("Created lock directory was replaced");
      this.owned = { dev: named.dev, ino: named.ino };
      await this.hooks.afterNative?.("lock.mkdir.created");
      this.handle = await fsp.open(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = await this.handle.stat();
      if (!opened.isDirectory() || !same(opened, this.owned))
        throw this.broken("Created lock descriptor incarnation changed");
      await this.named(this.owned);
    });
  }

  private stat(path: string, callback: Callback<fs.Stats>): void {
    this.dispatch("lock.stat", callback, async () => {
      this.checkPath(path);
      const stat = this.owned ? await this.named(this.owned) : await fsp.lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw this.broken("Expected a lock directory");
      if (!this.owned) this.candidate = stat;
      return stat;
    });
  }

  private utimes(path: string, atime: fs.TimeLike, mtime: fs.TimeLike, callback: Callback): void {
    this.dispatch("lock.utimes", callback, async () => {
      this.checkPath(path);
      if (!this.handle || !this.owned) throw this.broken("No lock descriptor for heartbeat");
      await this.named(this.owned);
      // Never update a successor by pathname, including a callback delayed across release.
      await this.handle.utimes(atime, mtime);
      await this.named(this.owned);
    });
  }

  private rmdir(path: string, callback: Callback): void {
    this.dispatch(
      "lock.rmdir",
      callback,
      async () => {
        this.checkPath(path);
        if (this.owned) {
          await this.named(this.owned);
        } else {
          // The public stale-reap path is bound to the stat it actually observed.
          const candidate = this.candidate;
          if (!candidate) throw error("ELOCKED", "No observed stale lock candidate");
          const current = await this.named(candidate, false);
          if (
            current.mtimeMs !== candidate.mtimeMs ||
            current.mtimeMs >= Date.now() - LOCK_STALE_MS
          )
            throw error("ELOCKED", "Stale candidate changed or became fresh");
        }
        // This identity check is not an atomic defence against an arbitrary same-UID rename race.
        await fsp.rmdir(path);
        this.created = false;
      },
      true,
    );
  }

  private exitRemove(path: string): void {
    this.checkPath(path);
    if (this.pending || !this.owned || this.phase !== "active")
      throw error("EBUSY", "Async cleanup cannot run in an exit hook");
    const stat = fs.lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(stat, this.owned))
      throw this.broken("Exit cleanup refused a successor lock");
    fs.rmdirSync(path);
  }

  private async drain(): Promise<void> {
    while (this.pending) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Call exactly once, including a failed acquire that never returned a public release handle. */
  close(release?: () => Promise<void>): Promise<void> {
    this.cleanup ??= this.finish(release);
    return this.cleanup;
  }

  private async finish(release?: () => Promise<void>): Promise<void> {
    if (this.phase === "closed") return;
    this.phase = "draining";
    await this.drain();
    this.phase = "releasing";
    try {
      if (release) {
        // No await between the drained continuation and public unlock clearing timer/map.
        await release();
      } else if (this.created && this.owned) {
        // mkdir succeeded but descriptor/probe/grant failed: do not pretend no lock was created.
        await new Promise<void>((resolve, reject) =>
          this.rmdir(this.path, (cause) => (cause ? reject(cause) : resolve())),
        );
      } else if (this.created) {
        throw this.broken("Created lock has no provable cleanup incarnation; unknown retained");
      }
    } catch (cause) {
      this.cleanupFailures.push(cause);
      this.onFailure(cause);
    }
    await this.drain();
    if (this.handle) {
      const handle = this.handle;
      this.handle = undefined;
      try {
        await handle.close();
      } catch (cause) {
        this.cleanupFailures.push(cause);
        this.onFailure(cause);
      }
    }
    this.phase = "closed";
    if (this.cleanupFailures.length) throw combineFailures(this.cleanupFailures);
  }
}
