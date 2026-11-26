/**
 * Worker-side owner of one native plugin process: start, handshake, calls
 * with deadlines, liveness, shutdown and the on-disk record that lets the
 * next worker find a process this one failed to stop.
 *
 * Nothing here interprets a plugin's results; that is the module adapter's
 * job. This class only moves messages and decides when a process is dead.
 */

import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSandboxEnv, groupAlive, killProcessGroup } from "../runtime/spawn-common.js";
import {
  fitsPluginMessage,
  PING_TIMEOUT_MS,
  PLUGIN_PROTOCOL_VERSION,
  SETUP_TIMEOUT_MS,
  type NativeDeclarations,
  type PluginInvocationKind,
  type PluginToWorkerMessage,
  type WorkerToPluginMessage,
} from "./protocol.js";

/** Calls beyond this many wait their turn instead of piling onto the process. */
export const MAX_IN_FLIGHT_CALLS = 16;
const MAX_QUEUED_CALLS = 256;
const MAX_LOG_BYTES = 1024 * 1024;
const STOP_GRACE_MS = 2_000;
const PROCESS_MARKER = "--codeshell-plugin-process=";

export type PluginCallErrorCode =
  | "TIMEOUT"
  | "CANCELLED"
  | "PLUGIN_UNAVAILABLE"
  | "BUSY"
  | "MESSAGE_TOO_LARGE"
  | "HANDLER_ERROR"
  | (string & {});

export class PluginCallError extends Error {
  constructor(
    readonly code: PluginCallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PluginCallError";
  }
}

export interface PluginProcessSpec {
  moduleId: string;
  plugin: string;
  installKey: string;
  /** The verified, read-only snapshot the entry is imported from. */
  root: string;
  main: string;
  dataDir: string;
  logFile: string;
  /** Directory holding one record per live plugin process. */
  pidDir: string;
  apiVersion: number;
  hostKind: string;
}

/**
 * Why a process is gone. Only `crashed` and `unresponsive` count against the
 * plugin: the other two are decisions this side made.
 */
export type PluginExitReason = "requested" | "setup" | "unresponsive" | "crashed";

export interface PluginProcessOptions {
  /** Overridable for tests; defaults to the compiled entry next to this file. */
  entry?: string;
  setupTimeoutMs?: number;
  pingTimeoutMs?: number;
  onExit?(info: {
    code: number | null;
    signal: NodeJS.Signals | null;
    reason: PluginExitReason;
  }): void;
}

export interface PluginProcessStats {
  pid?: number;
  startedAt?: number;
  calls: number;
  failures: number;
  timeouts: number;
  lastError?: string;
  lastErrorAt?: number;
}

interface PendingCall {
  id: number;
  message: Extract<WorkerToPluginMessage, { t: "invoke" }>;
  resolve(value: unknown): void;
  reject(error: PluginCallError): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  sent: boolean;
}

function defaultEntry(): string {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./child-main${extension}`, import.meta.url));
}

let nextCallId = 0;

export class PluginProcess {
  private child: ChildProcess | undefined;
  private starting: Promise<NativeDeclarations> | undefined;
  private ready = false;
  private exitReason: Exclude<PluginExitReason, "crashed"> | undefined;
  private readonly calls = new Map<number, PendingCall>();
  private readonly queue: PendingCall[] = [];
  private active = 0;
  private pingTimer: ReturnType<typeof setTimeout> | undefined;
  private pingId = 0;
  private log: WriteStream | undefined;
  private logBytes = 0;
  private pidFile: string | undefined;
  private exited: Promise<void> = Promise.resolve();
  readonly stats: PluginProcessStats = { calls: 0, failures: 0, timeouts: 0 };

  constructor(
    readonly spec: PluginProcessSpec,
    private readonly options: PluginProcessOptions = {},
  ) {}

  get isReady(): boolean {
    return this.ready;
  }

  get inFlight(): number {
    return this.calls.size;
  }

  /** Start the process and run the plugin's `setup`. Resolves with what it registered. */
  start(): Promise<NativeDeclarations> {
    if (this.starting) return this.starting;
    this.starting = this.launch();
    return this.starting;
  }

  private launch(): Promise<NativeDeclarations> {
    const { spec } = this;
    mkdirSync(spec.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(spec.logFile), { recursive: true, mode: 0o700 });
    mkdirSync(spec.pidDir, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const child = fork(this.options.entry ?? defaultEntry(), [`${PROCESS_MARKER}${token}`], {
      execPath: process.execPath,
      execArgv: process.versions.bun ? ["--smol"] : ["--max-old-space-size=256"],
      cwd: spec.dataDir,
      env: {
        ...buildSandboxEnv(),
        // Without this an Electron binary starts as a second application.
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        CODESHELL_PLUGIN_ROOT: spec.root,
        CODESHELL_PLUGIN_DATA: spec.dataDir,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      // Its own process group, so everything it starts can be stopped with it.
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.stats.pid = child.pid;
    this.stats.startedAt = Date.now();
    this.openLog();
    this.writeLog("info", `started pid ${child.pid} from ${spec.root}`);
    if (child.pid !== undefined) {
      this.pidFile = join(spec.pidDir, `${child.pid}.json`);
      try {
        writeFileSync(
          this.pidFile,
          JSON.stringify({
            pid: child.pid,
            token,
            moduleId: spec.moduleId,
            owner: process.pid,
            startedAt: Date.now(),
          }),
          { mode: 0o600 },
        );
      } catch {
        this.pidFile = undefined;
      }
    }
    child.stdout?.on("data", (chunk: Buffer) => this.writeLog("stdout", chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => this.writeLog("stderr", chunk.toString("utf8")));
    this.exited = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        this.onExit(child, code, signal);
        resolve();
      });
    });

    return new Promise<NativeDeclarations>((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer);
        this.stats.lastError = message;
        this.stats.lastErrorAt = Date.now();
        this.kill("setup");
        reject(new PluginCallError("PLUGIN_UNAVAILABLE", message));
      };
      const timer = setTimeout(
        () => fail("the plugin did not finish setup in time"),
        this.options.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
      );
      child.once("error", (error) => fail(`the plugin process could not start: ${error.message}`));
      child.once("exit", () => fail("the plugin process exited during setup"));
      child.on("message", (raw: PluginToWorkerMessage) => {
        if (this.child !== child || !raw || typeof raw !== "object") return;
        if (raw.t === "ready" && !this.ready) {
          clearTimeout(timer);
          this.ready = true;
          resolve(raw.declarations);
        } else if (raw.t === "failed" && !this.ready) {
          fail(`setup failed: ${String(raw.error).slice(0, 2_000)}`);
        } else {
          this.onMessage(raw);
        }
      });
      this.post({
        t: "init",
        protocol: PLUGIN_PROTOCOL_VERSION,
        apiVersion: spec.apiVersion,
        plugin: {
          name: spec.plugin,
          installKey: spec.installKey,
          root: spec.root,
          main: spec.main,
          dataDir: spec.dataDir,
        },
        host: { kind: spec.hostKind },
      });
    });
  }

  /** Call one registered handler. Rejects with a PluginCallError; never throws synchronously. */
  invoke(
    kind: PluginInvocationKind,
    name: string,
    payload: unknown,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ready || this.exitReason) {
        return reject(
          new PluginCallError("PLUGIN_UNAVAILABLE", "the plugin process is not running"),
        );
      }
      if (options.signal?.aborted) {
        return reject(new PluginCallError("CANCELLED", "the call was cancelled"));
      }
      const id = ++nextCallId;
      const message = { t: "invoke" as const, id, kind, name, payload };
      if (!fitsPluginMessage(message)) {
        return reject(
          new PluginCallError("MESSAGE_TOO_LARGE", "the call does not fit in one message"),
        );
      }
      if (this.queue.length >= MAX_QUEUED_CALLS) {
        return reject(new PluginCallError("BUSY", "too many calls are waiting for this plugin"));
      }
      const call: PendingCall = {
        id,
        message,
        resolve,
        reject,
        sent: false,
        signal: options.signal,
        // The deadline covers the wait for a free slot too: what the caller
        // experiences is the time until an answer, wherever it was spent.
        timer: setTimeout(() => this.onTimeout(call), options.timeoutMs),
      };
      if (options.signal) {
        call.onAbort = () => {
          this.cancel(call);
          this.settle(call, new PluginCallError("CANCELLED", "the call was cancelled"));
        };
        options.signal.addEventListener("abort", call.onAbort, { once: true });
      }
      this.calls.set(id, call);
      this.stats.calls += 1;
      this.queue.push(call);
      this.pump();
    });
  }

  /** Start or stop the plugin's background effects. */
  setBackground(run: boolean): void {
    if (this.ready) this.post({ t: "background", run });
  }

  /**
   * Stop the process. It is first asked to leave by closing the channel; one
   * that does not is killed together with everything it started.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || this.exitReason) return this.exited;
    this.exitReason = "requested";
    try {
      if (child.connected) child.disconnect();
    } catch {
      /* already closed */
    }
    const timer = setTimeout(() => this.kill("requested"), STOP_GRACE_MS);
    await this.exited;
    clearTimeout(timer);
  }

  /**
   * Stop once the calls already in flight have been answered. Used when a
   * newer process has taken over: nothing new arrives here, and what is
   * running gets to finish instead of failing because of an update.
   */
  async retire(graceMs = 30_000): Promise<void> {
    const deadline = Date.now() + graceMs;
    while (this.ready && this.calls.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await this.stop();
  }

  /** Kill the process group now, along with everything the plugin started. */
  kill(reason: Exclude<PluginExitReason, "crashed"> = "requested"): void {
    const child = this.child;
    if (!child) return;
    this.exitReason ??= reason;
    if (child.pid !== undefined) void killProcessGroup(child.pid, { graceMs: 0 });
    else child.kill("SIGKILL");
  }

  private pump(): void {
    while (this.active < MAX_IN_FLIGHT_CALLS && this.queue.length > 0) {
      const call = this.queue.shift()!;
      if (!this.calls.has(call.id)) continue;
      call.sent = true;
      this.active += 1;
      this.post(call.message);
    }
  }

  private post(message: WorkerToPluginMessage): void {
    const child = this.child;
    if (!child?.connected) return;
    try {
      child.send(message, () => {
        /* delivery errors surface as the channel closing */
      });
    } catch {
      /* the exit handler settles whatever was waiting */
    }
  }

  private onMessage(raw: PluginToWorkerMessage): void {
    if (raw.t === "result") {
      const call = this.calls.get(raw.id);
      if (!call) return;
      if (raw.ok) this.settle(call, undefined, raw.value);
      else {
        this.settle(
          call,
          new PluginCallError(
            String(raw.error?.code ?? "HANDLER_ERROR"),
            String(raw.error?.message ?? "the plugin reported an error"),
          ),
        );
      }
    } else if (raw.t === "pong") {
      if (raw.id === this.pingId) {
        clearTimeout(this.pingTimer);
        this.pingTimer = undefined;
      }
    } else if (raw.t === "log") {
      this.writeLog(String(raw.level), String(raw.message));
    }
  }

  private cancel(call: PendingCall): void {
    if (call.sent) this.post({ t: "cancel", id: call.id });
  }

  private onTimeout(call: PendingCall): void {
    if (!this.calls.has(call.id)) return;
    this.stats.timeouts += 1;
    this.cancel(call);
    const wasSent = call.sent;
    this.settle(call, new PluginCallError("TIMEOUT", "the plugin did not answer in time"));
    // A handler that is merely slow still answers a ping; one stuck in a
    // synchronous loop cannot, and no cancel will ever reach it.
    if (wasSent && !this.pingTimer && this.ready && !this.exitReason) {
      const id = ++this.pingId;
      this.post({ t: "ping", id });
      this.pingTimer = setTimeout(() => {
        this.pingTimer = undefined;
        this.writeLog("error", "no answer to a liveness check; killing the process");
        this.kill("unresponsive");
      }, this.options.pingTimeoutMs ?? PING_TIMEOUT_MS);
    }
  }

  private settle(call: PendingCall, error?: PluginCallError, value?: unknown): void {
    if (!this.calls.delete(call.id)) return;
    clearTimeout(call.timer);
    if (call.onAbort) call.signal?.removeEventListener("abort", call.onAbort);
    if (call.sent) this.active -= 1;
    if (error) {
      this.stats.failures += 1;
      this.stats.lastError = `${error.code}: ${error.message}`;
      this.stats.lastErrorAt = Date.now();
      call.reject(error);
    } else {
      call.resolve(value);
    }
    this.pump();
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    const reason = this.exitReason ?? "crashed";
    this.child = undefined;
    this.ready = false;
    clearTimeout(this.pingTimer);
    this.pingTimer = undefined;
    for (const call of [...this.calls.values()]) {
      this.settle(call, new PluginCallError("PLUGIN_UNAVAILABLE", "the plugin process exited"));
    }
    this.queue.length = 0;
    this.active = 0;
    this.writeLog("info", `exited code=${code} signal=${signal}`);
    this.log?.end();
    this.log = undefined;
    if (this.pidFile) rmSync(this.pidFile, { force: true });
    this.options.onExit?.({ code, signal, reason });
  }

  private openLog(): void {
    try {
      this.logBytes = statSync(this.spec.logFile).size;
    } catch {
      this.logBytes = 0;
    }
    this.log = createWriteStream(this.spec.logFile, { flags: "a", mode: 0o600 });
    this.log.on("error", () => {
      this.log = undefined;
    });
  }

  private writeLog(level: string, text: string): void {
    if (!this.log) return;
    const line = `${new Date().toISOString()} [${level}] ${text.replace(/\s+$/, "")}\n`;
    this.logBytes += Buffer.byteLength(line);
    if (this.logBytes > MAX_LOG_BYTES) {
      // Keep one previous file; a chatty plugin must not fill the disk.
      this.log.end();
      try {
        renameSync(this.spec.logFile, `${this.spec.logFile}.1`);
      } catch {
        /* keep appending to the same file */
      }
      this.logBytes = Buffer.byteLength(line);
      this.log = createWriteStream(this.spec.logFile, { flags: "a", mode: 0o600 });
      this.log.on("error", () => {
        this.log = undefined;
      });
    }
    this.log.write(line);
  }
}

function processInfo(pid: number): { parent: number; command: string } | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const out = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /^\s*(\d+)\s+([\s\S]*)$/.exec(out);
    return match ? { parent: Number(match[1]), command: match[2]! } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stop plugin processes a previous worker left behind. A worker that is
 * killed outright cannot stop its plugins; they normally notice the closed
 * channel and leave, but one stuck in a synchronous loop never does.
 *
 * Several workers can share one home directory, so a record alone proves
 * nothing. A process is only stopped when it still carries the record's random
 * token on its command line (a recycled process id is never signalled) and the
 * worker that started it is no longer its parent (a live worker keeps its
 * plugins). Returns the module ids whose processes were stopped.
 */
export async function reapLeftoverPluginProcesses(pidDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = readdirSync(pidDir);
  } catch {
    return [];
  }
  const reaped: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(pidDir, name);
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as {
        pid?: unknown;
        token?: unknown;
        moduleId?: unknown;
        owner?: unknown;
      };
      const pid = record.pid;
      const info =
        typeof pid === "number" &&
        Number.isInteger(pid) &&
        pid > 1 &&
        typeof record.token === "string" &&
        /^[a-f0-9-]{36}$/.test(record.token) &&
        groupAlive(pid)
          ? processInfo(pid)
          : undefined;
      if (info?.command.includes(`${PROCESS_MARKER}${record.token}`)) {
        // Still a child of the worker that started it: that worker is alive
        // and owns both the process and this record.
        if (info.parent === record.owner) continue;
        await killProcessGroup(pid as number, { graceMs: 0 });
        reaped.push(String(record.moduleId ?? pid));
      }
    } catch {
      /* an unreadable record is only removed */
    }
    rmSync(file, { force: true });
  }
  return reaped;
}
