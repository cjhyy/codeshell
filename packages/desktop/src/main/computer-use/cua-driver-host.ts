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
import { accessSync, constants, existsSync, unlinkSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const CUA_HOST_MCP_SERVER_NAME = "host:cua-driver";

export type CuaDriverHostState = "idle" | "starting" | "running" | "restarting" | "failed" | "stopped";

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
  readonly socketReady?: (path: string) => boolean;
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

/**
 * macOS limits AF_UNIX paths to 104 bytes, which `~/Library/Application
 * Support/...` can exceed. The per-user TMPDIR is private (0700) and short.
 */
export function defaultCuaSocketPath(): string {
  return join(tmpdir(), `codeshell-cua-${userInfo().uid}.sock`);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
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
  private readonly spawnFn: SpawnFn;
  private readonly socketReady: (path: string) => boolean;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private child: ChildProcess | undefined;
  private state: CuaDriverHostState = "idle";
  private generation = 0;
  private restarts = 0;
  private lastError: string | undefined;
  private startPromise: Promise<void> | undefined;

  constructor(private readonly options: CuaDriverHostOptions) {
    this.socketPath = options.socketPath ?? defaultCuaSocketPath();
    this.spawnFn = options.spawn ?? (nodeSpawn as SpawnFn);
    this.socketReady = options.socketReady ?? existsSync;
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
    if (this.state === "running") return Promise.resolve();
    if (this.state === "stopped") return Promise.reject(new Error("cua-driver host is stopped"));
    this.startPromise ??= this.launch().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const timedOut = await Promise.race([
        exited.then(() => false),
        this.sleep(STOP_GRACE_MS).then(() => true),
      ]);
      if (timedOut) child.kill("SIGKILL");
    }
    this.removeStaleSocket();
    this.log("cua_driver_stopped", { generation: this.generation });
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

  private removeStaleSocket(): void {
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {
      // Best effort; the next daemon rebinds or reports the conflict.
    }
  }

  private async launch(): Promise<void> {
    this.state = this.generation === 0 ? "starting" : "restarting";
    this.removeStaleSocket();
    const generation = ++this.generation;
    const child = this.spawnFn(
      this.options.driverPath,
      ["serve", "--embedded", "--socket", this.socketPath],
      {
        env: this.daemonEnv(),
        // Direct child, no shell, no `open -a`: anything else would leave the
        // app's TCC responsibility chain.
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      },
    );
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) =>
      this.log("cua_driver_stdout", { generation, text: chunk.toString("utf8").slice(0, 800) }),
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      this.log("cua_driver_stderr", { generation, text: chunk.toString("utf8").slice(0, 800) }),
    );
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("exit", (code, signal) => this.onExit(generation, code, signal));

    const timeout = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (spawnError) break;
      if (this.child !== child) {
        this.state = "failed";
        this.lastError = "daemon exited during startup";
        throw new Error(this.lastError);
      }
      if (this.socketReady(this.socketPath)) {
        this.state = "running";
        this.lastError = undefined;
        this.log("cua_driver_running", { generation, socketPath: this.socketPath });
        return;
      }
      await this.sleep(50);
    }
    this.lastError = spawnError
      ? `spawn failed: ${spawnError.message}`
      : `socket not ready after ${timeout}ms`;
    this.state = "failed";
    if (this.child === child) {
      this.child = undefined;
      child.kill("SIGKILL");
    }
    throw new Error(this.lastError);
  }

  private onExit(generation: number, code: number | null, signal: NodeJS.Signals | null): void {
    if (generation !== this.generation || this.state === "stopped") return;
    this.child = undefined;
    this.log("cua_driver_exited", { generation, code, signal });
    if (this.state !== "running") return; // startup loop reports its own failure
    // In-flight actions of this generation have unknown completion; the MCP
    // proxy surfaces the broken socket and callers must re-observe. Never
    // replay an action here.
    const maxRestarts = this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    if (this.restarts >= maxRestarts) {
      this.state = "failed";
      this.lastError = `daemon exited (code=${code}, signal=${signal}); restart budget exhausted`;
      return;
    }
    const delay = 1_000 * 2 ** this.restarts++;
    this.state = "restarting";
    void this.sleep(delay).then(() => {
      if (this.state !== "restarting") return;
      this.start().catch((error) => this.log("cua_driver_restart_failed", { error: String(error) }));
    });
  }
}
