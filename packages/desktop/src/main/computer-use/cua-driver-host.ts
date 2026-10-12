/**
 * Embedded Cua Driver host (Computer Use spike, feature flag `computer_use_cua`).
 *
 * Electron main spawns `cua-driver serve --embedded` as a DIRECT child so the
 * daemon stays in this app's macOS TCC responsibility chain: Accessibility and
 * Screen Recording are granted once to CodeShell, never to a second identity.
 * Sessions reach the daemon through `cua-driver mcp --embedded --socket`, a
 * stdio proxy that executes nothing itself; the worker spawns that proxy as
 * the host-owned MCP server `host:cua-driver`.
 *
 * Contract: libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md in
 * https://github.com/trycua/cua ("Launching the daemon-backed host"). The
 * package `@trycua/cua-driver` ships `EmbeddedCuaDriverHost`, which wraps the
 * same contract; this file can be swapped for it once the dependency is added.
 *
 * Deliberately NOT done here: unrestricted mode, existing Chrome profile
 * grants, per-window authorization and the browser/terminal deny rules from
 * the design doc. This is the process skeleton only.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const CUA_HOST_MCP_SERVER_NAME = "host:cua-driver";

export type CuaDriverHostState =
  | "idle"
  | "starting"
  | "running"
  | "restarting"
  | "failed"
  | "stopped";

export interface CuaDriverHostStatus {
  readonly state: CuaDriverHostState;
  readonly driverPath?: string;
  readonly socketPath: string;
  readonly generation: number;
  readonly lastError?: string;
}

export interface CuaHostMcpDeclaration {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly inlineImages: true;
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface CuaDriverHostOptions {
  readonly driverPath: string;
  readonly hostBundleId: string;
  readonly socketPath?: string;
  readonly parentEnv?: NodeJS.ProcessEnv;
  readonly spawn?: SpawnFn;
  readonly socketReady?: (path: string) => boolean | Promise<boolean>;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
  readonly readyTimeoutMs?: number;
  readonly maxRestarts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Only these parent variables reach the daemon; API keys and tokens never do. */
const PARENT_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"];

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESTARTS = 3;
const STOP_GRACE_MS = 3_000;
const KILL_GRACE_MS = 1_000;

/**
 * macOS limits AF_UNIX paths to 104 bytes, which `~/Library/Application
 * Support/...` can exceed. Each host gets its own private directory so a dev
 * instance cannot unlink or connect to another instance's daemon socket.
 */
export function defaultCuaSocketPath(): string {
  const name = `cs-cua-${process.pid}-${randomBytes(6).toString("hex")}`;
  const path = join(tmpdir(), name, "driver.sock");
  return Buffer.byteLength(path) < 104 ? path : join("/tmp", name, "driver.sock");
}

function socketStat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** A bound socket is not ready until its listener accepts connections. */
async function socketAcceptsConnections(path: string): Promise<boolean> {
  if (!socketStat(path)?.isSocket()) return false;
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(100, () => finish(false));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate a cua-driver executable. An explicit override wins; a packaged app
 * prefers its bundled copy (outside ASAR, signed with the app); otherwise the
 * usual install locations are tried for the spike.
 */
export function resolveCuaDriverPath(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
  readonly resourcesPath?: string;
  readonly isExecutable?: (path: string) => boolean;
}): string | undefined {
  const check = options.isExecutable ?? isExecutable;
  const override = options.env?.CODESHELL_CUA_DRIVER_PATH?.trim();
  if (override) return check(override) ? override : undefined;
  const candidates = [
    ...(options.isPackaged && options.resourcesPath
      ? [join(options.resourcesPath, "cua-driver", "cua-driver")]
      : []),
    "/usr/local/bin/cua-driver",
    "/opt/homebrew/bin/cua-driver",
    join(homedir(), ".local", "bin", "cua-driver"),
  ];
  return candidates.find((candidate) => check(candidate));
}

export class CuaDriverHost {
  private readonly socketPath: string;
  private readonly socketDirectory: string | undefined;
  private socketDirectoryCreated = false;
  private socketClaimed = false;
  private readonly spawnFn: SpawnFn;
  private readonly socketReady: (path: string) => boolean | Promise<boolean>;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private child: ChildProcess | undefined;
  private state: CuaDriverHostState = "idle";
  private generation = 0;
  private restarts = 0;
  private lastError: string | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private termination: { child: ChildProcess; promise: Promise<boolean> } | undefined;

  constructor(private readonly options: CuaDriverHostOptions) {
    this.socketPath = options.socketPath ?? defaultCuaSocketPath();
    this.socketDirectory = options.socketPath ? undefined : dirname(this.socketPath);
    this.spawnFn = options.spawn ?? (nodeSpawn as SpawnFn);
    this.socketReady = options.socketReady ?? socketAcceptsConnections;
    this.log = options.log ?? (() => {});
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  status(): CuaDriverHostStatus {
    return {
      state: this.state,
      driverPath: this.options.driverPath,
      socketPath: this.socketPath,
      generation: this.generation,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /**
   * The stdio proxy the worker spawns as `host:cua-driver`. Stable across
   * daemon restarts (same socket path), so the worker env never goes stale.
   */
  mcpDeclaration(): CuaHostMcpDeclaration {
    return {
      command: this.options.driverPath,
      args: ["mcp", "--embedded", "--socket", this.socketPath],
      env: { CUA_DRIVER_EMBEDDED: "1" },
      inlineImages: true,
    };
  }

  /** Concurrent calls coalesce into one daemon generation. */
  start(): Promise<void> {
    if (this.state === "stopped") return Promise.reject(new Error("cua-driver host is stopped"));
    if (this.startPromise) return this.startPromise;
    if (this.state === "running") return Promise.resolve();
    if (this.child) return Promise.reject(new Error("previous cua-driver daemon is still running"));
    return this.beginStart();
  }

  stop(): Promise<void> {
    this.state = "stopped";
    this.stopPromise ??= this.shutdown();
    return this.stopPromise;
  }

  private beginStart(delay = 0): Promise<void> {
    const startup = delay ? this.sleep(delay).then(() => this.launch()) : this.launch();
    const pending = startup.finally(() => {
      if (this.startPromise === pending) this.startPromise = undefined;
    });
    this.startPromise = pending;
    return pending;
  }

  private async shutdown(): Promise<void> {
    const child = this.child;
    const terminated = !child || (await this.terminateChild(child));
    if (terminated) {
      if (this.child === child) this.child = undefined;
      this.cleanSocket();
    } else {
      this.lastError = "daemon did not exit after SIGKILL";
      this.log("cua_driver_stop_failed", { generation: this.generation, error: this.lastError });
    }
    this.log("cua_driver_stopped", { generation: this.generation });
  }

  private terminateChild(child: ChildProcess): Promise<boolean> {
    if (this.termination?.child === child) return this.termination.promise;
    const pending = this.waitForChildExit(child).finally(() => {
      if (this.termination?.promise === pending) this.termination = undefined;
    });
    this.termination = { child, promise: pending };
    return pending;
  }

  private async waitForChildExit(child: ChildProcess): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined)
      return true;
    let onExit: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      onExit = resolve;
      child.once("exit", onExit);
    });
    try {
      child.kill("SIGTERM");
      const timedOut = await Promise.race([
        exited.then(() => false),
        this.sleep(STOP_GRACE_MS).then(() => true),
      ]);
      if (!timedOut) return true;
      child.kill("SIGKILL");
      return await Promise.race([
        exited.then(() => true),
        this.sleep(KILL_GRACE_MS).then(() => false),
      ]);
    } catch (error) {
      this.log("cua_driver_terminate_failed", { error: errorMessage(error) });
      return false;
    } finally {
      child.removeListener("exit", onExit);
    }
  }

  private daemonEnv(): Record<string, string> {
    const parent = this.options.parentEnv ?? process.env;
    const env: Record<string, string> = {};
    for (const key of PARENT_ENV_ALLOWLIST) {
      const value = parent[key];
      if (typeof value === "string") env[key] = value;
    }
    env.CUA_DRIVER_EMBEDDED = "1";
    env.CUA_DRIVER_HOST_BUNDLE_ID = this.options.hostBundleId;
    // Fixed at trusted launch; never agent-settable. `standard` keeps residual
    // boundaries (such as an existing logged-in Chrome profile) denied because
    // this host installs no authorization handler.
    env.CUA_DRIVER_PERMISSION_MODE = "standard";
    return env;
  }

  private prepareSocket(): void {
    if (Buffer.byteLength(this.socketPath) >= 104) {
      throw new Error("cua-driver socket path exceeds the macOS 103-byte limit");
    }
    if (this.socketDirectory && !this.socketDirectoryCreated) {
      mkdirSync(this.socketDirectory, { mode: 0o700 });
      this.socketDirectoryCreated = true;
    }
    const stat = socketStat(this.socketPath);
    if (stat) {
      if (!this.socketClaimed || !stat.isSocket()) {
        throw new Error("cua-driver socket path is already in use");
      }
      unlinkSync(this.socketPath);
    }
    this.socketClaimed = true;
  }

  private cleanSocket(): void {
    const claimed = this.socketClaimed;
    // Cleanup ends this generation's authority even if unlink fails. A later
    // listener at an explicit path must never inherit our cleanup permission.
    this.socketClaimed = false;
    try {
      if (claimed && socketStat(this.socketPath)?.isSocket()) unlinkSync(this.socketPath);
      if (this.socketDirectoryCreated) {
        rmdirSync(this.socketDirectory!);
        this.socketDirectoryCreated = false;
      }
    } catch {
      // Never recursively remove a directory or unlink an unrelated file.
    }
  }

  private throwIfStopped(): void {
    if (this.state === "stopped") throw new Error("cua-driver host is stopped");
  }

  private async launch(): Promise<void> {
    this.throwIfStopped();
    this.state = this.generation === 0 ? "starting" : "restarting";
    const generation = ++this.generation;
    let child: ChildProcess | undefined;
    try {
      this.prepareSocket();
      try {
        child = this.spawnFn(
          this.options.driverPath,
          ["serve", "--embedded", "--socket", this.socketPath],
          {
            env: this.daemonEnv(),
            // Keep the direct-child macOS TCC responsibility chain.
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
          },
        );
      } catch (error) {
        throw new Error(`spawn failed: ${errorMessage(error)}`, { cause: error });
      }
      this.child = child;
      child.stdout?.on("data", (chunk: Buffer) =>
        this.log("cua_driver_stdout", { generation, text: chunk.toString("utf8").slice(0, 800) }),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        this.log("cua_driver_stderr", { generation, text: chunk.toString("utf8").slice(0, 800) }),
      );
      let spawnError: Error | undefined;
      child.on("error", (error) => {
        spawnError = error;
      });
      child.once("exit", (code, signal) => this.onExit(generation, code, signal));
      const activeChild = child;
      const checkStartup = () => {
        this.throwIfStopped();
        if (spawnError) throw new Error(`spawn failed: ${spawnError.message}`);
        if (
          this.child !== activeChild ||
          activeChild.exitCode !== null ||
          activeChild.signalCode !== null
        ) {
          throw new Error("daemon exited during startup");
        }
      };

      const timeout = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        checkStartup();
        const ready = await this.socketReady(this.socketPath);
        checkStartup();
        if (ready) {
          this.state = "running";
          this.lastError = undefined;
          this.log("cua_driver_running", { generation, socketPath: this.socketPath });
          return;
        }
        await this.sleep(50);
      }
      throw new Error(`socket not ready after ${timeout}ms`);
    } catch (error) {
      const terminated = !child || this.child !== child || (await this.terminateChild(child));
      if (terminated) {
        if (this.child === child) this.child = undefined;
        this.cleanSocket();
      }
      this.throwIfStopped();
      this.lastError = terminated
        ? errorMessage(error)
        : `${errorMessage(error)}; previous daemon did not exit after SIGKILL`;
      this.state = "failed";
      throw new Error(this.lastError, { cause: error });
    }
  }

  private onExit(generation: number, code: number | null, signal: NodeJS.Signals | null): void {
    if (generation !== this.generation || this.state === "stopped") return;
    this.child = undefined;
    this.log("cua_driver_exited", { generation, code, signal });
    if (this.state !== "running") return; // startup loop reports its own failure
    // Remove the exited generation's socket before backoff and relinquish its
    // claim. Another listener may legitimately bind an explicit path while we
    // wait; restart and stop must then preserve that listener.
    this.cleanSocket();
    // In-flight actions of this generation have unknown completion; the MCP
    // proxy surfaces the broken socket and callers must re-observe. Never
    // replay an action here.
    this.scheduleRestart(`daemon exited (code=${code}, signal=${signal})`);
  }

  private scheduleRestart(reason: string): void {
    if (this.state === "stopped") return;
    const maxRestarts = this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    if (this.child) {
      this.state = "failed";
      return;
    }
    if (this.restarts >= maxRestarts) {
      this.state = "failed";
      this.lastError = `${reason}; restart budget exhausted`;
      return;
    }
    const delay = 1_000 * 2 ** this.restarts++;
    this.state = "restarting";
    this.lastError = reason;
    void this.beginStart(delay).catch((error) => {
      if (this.state === "stopped") return;
      this.log("cua_driver_restart_failed", { error: String(error) });
      this.scheduleRestart(errorMessage(error));
    });
  }
}
