/**
 * BackgroundShellManager — session-scoped registry + lifecycle for
 * fire-and-forget background shells (design §4).
 *
 * A background shell is a long-lived process (typically `npm run dev`)
 * started via `Bash(run_in_background=true)`. Unlike the foreground Bash
 * path (which awaits the command to completion), this:
 *
 *   - spawns the command **detached** so it owns its own process group
 *     (so KillShell can reap the whole `sh → npm → node vite` tree, §难点2);
 *   - returns a `shell_id` immediately, never blocking the turn;
 *   - streams output to an in-memory ring buffer + a wrap-around disk file,
 *     stripping ANSI/progress noise only when handed to the agent (§难点4);
 *   - detects a served port best-effort from the output (§难点3);
 *   - is **completely separate** from `asyncAgentRegistry` so Engine.run's
 *     wait-for-background loop never waits on a dev server (§难点5);
 *   - on exit, enqueues a one-line completion notification (no output body,
 *     §难点6 / D6) keyed by sessionId.
 *
 * Lifetime is process-local and session-scoped: `killSession(sid)` on
 * explicit session deletion, `killAll()` on app/worker exit. Crashing the
 * worker leaks the detached children as orphans — pidfiles let a restarted
 * worker discover and reap them (§难点1, `reapOrphansFromPidfiles`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { resolveSpawnTarget, buildSandboxEnv, mergeShellEnv, killProcessGroup, groupAlive, defaultShellBinary } from "./spawn-common.js";
import { RingFile } from "./ring-file.js";
import { cleanOutput } from "./output-clean.js";
import { notificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { logger } from "../logging/logger.js";
import type { SandboxBackend } from "../tool-system/sandbox/index.js";

export type BgShellStatus = "starting" | "running" | "exited" | "killed" | "orphaned";

/** Per-session soft cap on background shells (design §7 — fork-bomb guard). */
export const MAX_SHELLS_PER_SESSION = 16;

/** Disk ring-file cap: keep the most recent 8MB of raw output (design §6). */
const DISK_CAP_BYTES = 8 * 1024 * 1024;

/** BashOutput single-return cap (strip后尾部 ~16KB) so one read can't blow context. */
const READ_RETURN_CAP = 16 * 1024;

const KILL_GRACE_MS = 3000;

interface PidfileRecord {
  shellId: string;
  pgid: number;
  command: string;
  port?: number;
  startedAt: number;
  sessionId: string;
}

export interface BgShell {
  shellId: string;
  sessionId: string;
  command: string;
  cwd: string;
  pgid: number;
  status: BgShellStatus;
  startedAt: number;
  exitedAt?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  detectedPort?: number;
  /** Absolute stream position (RingFile.totalWritten) already returned to the
   *  agent. Absolute — not window-relative — so it survives ring wraparound. */
  agentReadOffset: number;
  /** Total bytes the shell has written so far (monotonic, survives ring
   *  wraparound). Lets the UI show live progress for long jobs like downloads
   *  ("↑ 1.1 GB") even though the panel doesn't parse the output itself. */
  totalBytes: number;
  didWrap: boolean;
  diskAvailable: boolean;
}

export interface SpawnBackgroundOptions {
  command: string;
  cwd: string;
  sessionId: string;
  shell?: string;
  sandbox?: SandboxBackend;
  /**
   * Project `localEnvironment.env` to layer on top of the base shell env
   * (see mergeShellEnv). Same source as the foreground Bash tool's
   * `ctx.shellEnv` — passed through so a background dev server sees the same
   * project env as a one-shot command.
   */
  shellEnv?: Record<string, string>;
}

export type SpawnResult =
  | { ok: true; shellId: string }
  | { ok: false; error: string };

export type ReadResult =
  | { ok: true; text: string; header: string }
  | { ok: false; error: string };

export type KillResult =
  | { ok: true; alreadyExited?: boolean; status: BgShellStatus }
  | { ok: false; error: string };

// `totalBytes` is a derived public-snapshot field (computed from `ring` in
// toPublic), so the internal record omits it rather than storing a stale copy.
interface InternalShell extends Omit<BgShell, "totalBytes"> {
  child: ChildProcess | null;
  ring: RingFile;
  pidfilePath: string;
  stdoutDec: StringDecoder;
  stderrDec: StringDecoder;
  /** Accumulated raw (un-stripped) text, for port detection scanning window. */
  portScanBuf: string;
}

let shellCounter = 0;
function nextShellId(): string {
  shellCounter += 1;
  // Short, collision-resistant enough within a process: counter + base36 of
  // a monotonic-ish value. Avoids Date.now()/Math.random() (banned in some
  // contexts and unnecessary here).
  return `bg_${shellCounter.toString(36)}${(shellCounter * 2654435761 % 0xffffff).toString(36)}`;
}

function bgShellsRoot(): string {
  const base = process.env.CODE_SHELL_HOME ?? process.env.HOME ?? homedir();
  return join(base, ".code-shell", "bg-shells");
}

const PORT_REGEXES = [
  /localhost:(\d{2,5})/i,
  /127\.0\.0\.1:(\d{2,5})/,
  /0\.0\.0\.0:(\d{2,5})/,
  /:(\d{4,5})\b/,
];

function detectPort(text: string): number | undefined {
  for (const re of PORT_REGEXES) {
    const m = re.exec(text);
    if (m) {
      const p = Number(m[1]);
      if (p >= 1 && p <= 65535) return p;
    }
  }
  return undefined;
}

export class BackgroundShellManager {
  private shells = new Map<string, InternalShell>();

  spawnBackground(opts: SpawnBackgroundOptions): SpawnResult {
    // Defense-in-depth: sessionId becomes a directory under bgShellsRoot()
    // (`join(root, sessionId)`, below). It's engine-generated/validated today,
    // but a `..`/separator/empty id would write the shell log + record OUTSIDE
    // the bg-shells root — refuse rather than trust the caller. Mirrors
    // SessionManager.assertSafeSessionId without importing across the layer.
    const sid = opts.sessionId;
    if (typeof sid !== "string" || sid.length === 0 || sid.includes("..") || sid.includes("/") || sid.includes("\\")) {
      return { ok: false, error: `invalid sessionId for background shell` };
    }
    // Per-session soft cap (fork-bomb guard, §7).
    const live = [...this.shells.values()].filter(
      (s) => s.sessionId === opts.sessionId && (s.status === "running" || s.status === "starting"),
    );
    if (live.length >= MAX_SHELLS_PER_SESSION) {
      return {
        ok: false,
        error: `Too many background shells for this session (max ${MAX_SHELLS_PER_SESSION}). KillShell some first.`,
      };
    }

    const shell = opts.shell ?? defaultShellBinary();
    const { file, args } = resolveSpawnTarget(opts.command, {
      cwd: opts.cwd,
      shell,
      sandbox: opts.sandbox,
    });
    const baseEnv =
      opts.sandbox && opts.sandbox.name !== "off" ? buildSandboxEnv() : { ...process.env };
    const env = mergeShellEnv(baseEnv, opts.shellEnv);

    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env,
        // POSIX: detached → own process group so a negative-pid signal reaps
        // the whole tree (npm → node → vite). Windows has no process groups;
        // detached there spawns a separate console window instead, so we keep
        // it attached and rely on `taskkill /T` (killProcessGroup's win32
        // branch) to reap the tree. windowsHide stops a console flashing up.
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return { ok: false, error: `Failed to spawn background shell: ${(err as Error).message}` };
    }

    if (child.pid === undefined) {
      return { ok: false, error: "Failed to spawn background shell: no pid" };
    }

    const shellId = nextShellId();
    const pgid = child.pid; // detached ⇒ pgid == pid
    const dir = join(bgShellsRoot(), opts.sessionId);
    const pidfilePath = join(dir, `${shellId}.json`);
    const logPath = join(dir, `${shellId}.log`);

    let ring: RingFile;
    try {
      mkdirSync(dir, { recursive: true });
      ring = new RingFile(logPath, DISK_CAP_BYTES);
    } catch {
      // Disk unavailable — degrade to a memory-only ring at a temp-less path.
      ring = new RingFile(join(dir, `${shellId}.log`), DISK_CAP_BYTES);
    }

    const startedAt = Date.now();
    const rec: PidfileRecord = {
      shellId,
      pgid,
      command: opts.command,
      startedAt,
      sessionId: opts.sessionId,
    };
    try {
      writeFileSync(pidfilePath, JSON.stringify(rec), "utf8");
    } catch {
      /* pidfile is best-effort; orphan reaping just won't see this one */
    }

    const sh: InternalShell = {
      shellId,
      sessionId: opts.sessionId,
      command: opts.command,
      cwd: opts.cwd,
      pgid,
      status: "running",
      startedAt,
      exitCode: null,
      signal: null,
      agentReadOffset: 0,
      didWrap: false,
      diskAvailable: ring.diskAvailable(),
      child,
      ring,
      pidfilePath,
      stdoutDec: new StringDecoder("utf-8"),
      stderrDec: new StringDecoder("utf-8"),
      portScanBuf: "",
    };
    this.shells.set(shellId, sh);

    const onData = (chunk: Buffer): void => {
      sh.ring.write(chunk);
      sh.didWrap = sh.ring.didWrap();
      if (sh.detectedPort === undefined) {
        // Scan a bounded recent window of decoded text for a port.
        sh.portScanBuf = (sh.portScanBuf + chunk.toString("utf8")).slice(-4096);
        const p = detectPort(sh.portScanBuf);
        if (p !== undefined) {
          sh.detectedPort = p;
          this.updatePidfilePort(sh, p);
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      logger.warn("bg_shell.child_error", { shellId, error: (err as Error).message });
    });

    child.on("exit", (code, sig) => {
      // Only natural exits land here as "exited"; kill() sets "killed" first.
      if (sh.status === "killed") {
        this.finalize(sh, code, sig);
        return;
      }
      sh.status = "exited";
      this.finalize(sh, code, sig);
      this.enqueueExitNotification(sh);
    });

    return { ok: true, shellId };
  }

  private finalize(sh: InternalShell, code: number | null, sig: NodeJS.Signals | null): void {
    sh.exitCode = code;
    sh.signal = sig;
    sh.exitedAt = Date.now();
    sh.child = null;
    try {
      sh.ring.close();
    } catch {
      /* best-effort */
    }
    try {
      rmSync(sh.pidfilePath, { force: true });
    } catch {
      /* best-effort */
    }
  }

  private enqueueExitNotification(sh: InternalShell): void {
    const ok = sh.exitCode === 0;
    const exitDesc = sh.signal
      ? `signal ${sh.signal}`
      : `exit ${sh.exitCode ?? "?"}`;
    notificationQueue.enqueue(
      {
        agentId: sh.shellId,
        // English description is the agent-facing wakeup text. The UI ignores
        // it for the toast and uses workKind + command to build a localized
        // label (see bgCompletionText in desktop renderer types.ts). No `name`
        // so legacy UIs fall back to their own default rather than showing the
        // English "background shell" brand string.
        description: `Background shell exited (${exitDesc}): ${sh.command}`,
        status: ok ? "completed" : "failed",
        workKind: "shell",
        command: sh.command,
        error: ok ? undefined : `Background shell ${sh.shellId} exited with ${exitDesc}. Use BashOutput("${sh.shellId}") to inspect.`,
        enqueuedAt: Date.now(),
      },
      sh.sessionId,
    );
  }

  private updatePidfilePort(sh: InternalShell, port: number): void {
    try {
      const rec: PidfileRecord = {
        shellId: sh.shellId,
        pgid: sh.pgid,
        command: sh.command,
        port,
        startedAt: sh.startedAt,
        sessionId: sh.sessionId,
      };
      writeFileSync(sh.pidfilePath, JSON.stringify(rec), "utf8");
    } catch {
      /* best-effort */
    }
  }

  get(shellId: string): BgShell | undefined {
    const sh = this.shells.get(shellId);
    return sh ? this.toPublic(sh) : undefined;
  }

  /** Raw retained output (no cleaning) — test/UI helper. */
  readOutputRaw(shellId: string): string | undefined {
    return this.shells.get(shellId)?.ring.readAll();
  }

  listForSession(sessionId: string): BgShell[] {
    return [...this.shells.values()]
      .filter((s) => s.sessionId === sessionId)
      .map((s) => this.toPublic(s));
  }

  /**
   * Read a shell's output. `mode=incremental` (default) returns text since the
   * agent's last read; `mode=all` returns the full retained buffer. Output is
   * ANSI-stripped and progress-folded, capped at the last READ_RETURN_CAP
   * chars. `expectSessionId`, when given, enforces session ownership.
   */
  readOutput(
    shellId: string,
    mode: "incremental" | "all" = "incremental",
    expectSessionId?: string,
  ): ReadResult {
    const sh = this.shells.get(shellId);
    if (!sh) return { ok: false, error: `Unknown shell_id: ${shellId}` };
    if (expectSessionId !== undefined && sh.sessionId !== expectSessionId) {
      return { ok: false, error: `Unknown shell_id: ${shellId}` };
    }

    let rawSlice: string;
    let capped = false;
    if (mode === "all") {
      // Snapshot of the full retained buffer. This is explicitly a "show me the
      // tail" view — when it exceeds the cap we keep the LAST 16KB (most recent
      // output) and don't touch the incremental cursor.
      rawSlice = sh.ring.readAll();
      let text = cleanOutput(rawSlice);
      if (text.length > READ_RETURN_CAP) {
        text = text.slice(-READ_RETURN_CAP);
        capped = true;
      }
      return { ok: true, text, header: this.buildHeader(sh, capped, "all") };
    }

    // Incremental: deliver bytes since the agent's last read WITHOUT dropping
    // any. A single burst larger than the cap is paginated across successive
    // reads — we consume only the leading READ_RETURN_CAP *raw* bytes this call
    // and advance the absolute cursor by exactly that many, so the remainder is
    // returned next read. (Truncating to the trailing 16KB while advancing the
    // cursor to the end silently dropped the earliest bytes forever — #5.)
    //
    // Absolute stream cursor — survives ring wraparound (a window-relative
    // offset would silently skip new bytes once the window slides).
    const sliceBuf = sh.ring.sliceFromAbsolute(sh.agentReadOffset);
    let consumedBytes = sliceBuf.length;
    let rawBuf = sliceBuf;
    if (rawBuf.length > READ_RETURN_CAP) {
      // Cap on RAW bytes (not cleaned length): cleanOutput only ever shrinks,
      // so the cleaned result of the first 16KB raw bytes is itself ≤ 16KB and
      // won't need a second truncation. Advancing the cursor by exactly
      // consumedBytes keeps the next read seamless.
      rawBuf = rawBuf.subarray(0, READ_RETURN_CAP);
      consumedBytes = READ_RETURN_CAP;
      capped = true;
    }
    rawSlice = rawBuf.toString("utf8");
    sh.agentReadOffset += consumedBytes;

    const text = cleanOutput(rawSlice);
    return { ok: true, text, header: this.buildHeader(sh, capped, "incremental") };
  }

  /**
   * Build the status header line for a readOutput result. `mode` shapes the cap
   * note: `all` keeps the trailing 16KB (older output omitted from THIS view),
   * while incremental paginates (more output available on the next read).
   */
  private buildHeader(sh: InternalShell, capped: boolean, mode: "incremental" | "all"): string {
    const portPart = sh.detectedPort !== undefined ? ` port=${sh.detectedPort}` : "";
    const exitPart =
      sh.status === "exited" || sh.status === "killed"
        ? sh.signal
          ? ` signal=${sh.signal}`
          : ` exit=${sh.exitCode ?? "?"}`
        : "";
    const wrapNote = sh.didWrap ? " (older output discarded)" : "";
    const capNote = capped
      ? mode === "all"
        ? " (showing last 16KB)"
        : " (16KB this read; call again for more)"
      : "";
    const diskNote = sh.diskAvailable ? "" : " (disk buffer unavailable)";
    return `[${sh.shellId} status=${sh.status}${portPart}${exitPart}]${wrapNote}${capNote}${diskNote}`;
  }

  /** Terminate a shell (its whole process group). Idempotent. */
  async kill(shellId: string, expectSessionId?: string): Promise<KillResult> {
    const sh = this.shells.get(shellId);
    if (!sh) return { ok: false, error: `Unknown shell_id: ${shellId}` };
    if (expectSessionId !== undefined && sh.sessionId !== expectSessionId) {
      return { ok: false, error: `Unknown shell_id: ${shellId}` };
    }
    if (sh.status === "exited" || sh.status === "killed") {
      return { ok: true, alreadyExited: true, status: sh.status };
    }
    sh.status = "killed";
    await killProcessGroup(sh.pgid, { graceMs: KILL_GRACE_MS });
    // The 'exit' handler runs finalize(); if the child already detached/died
    // without firing it, finalize defensively.
    if (sh.exitedAt === undefined) {
      this.finalize(sh, sh.exitCode, sh.signal);
    }
    return { ok: true, status: "killed" };
  }

  /** Kill every background shell belonging to `sessionId`. */
  async killSession(sessionId: string): Promise<void> {
    const ids = [...this.shells.values()]
      .filter((s) => s.sessionId === sessionId && (s.status === "running" || s.status === "starting"))
      .map((s) => s.shellId);
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  /** Kill every background shell (app/worker exit). */
  async killAll(): Promise<void> {
    const ids = [...this.shells.values()]
      .filter((s) => s.status === "running" || s.status === "starting")
      .map((s) => s.shellId);
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  /**
   * Scan pidfiles left by a previous (crashed) worker. For each: if the pgid
   * is still alive it's an orphan (the dev server outlived its worker) — list
   * it as `orphaned` so KillShell can clean it up; if dead, delete the stale
   * pidfile. Returns the orphaned records found.
   */
  reapOrphansFromPidfiles(): PidfileRecord[] {
    const root = bgShellsRoot();
    if (!existsSync(root)) return [];
    const orphans: PidfileRecord[] = [];
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(root);
    } catch {
      return [];
    }
    for (const sid of sessionDirs) {
      const dir = join(root, sid);
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const path = join(dir, f);
        let rec: PidfileRecord;
        try {
          rec = JSON.parse(readFileSync(path, "utf8")) as PidfileRecord;
        } catch {
          try { rmSync(path, { force: true }); } catch { /* ignore */ }
          continue;
        }
        // Skip ones we already track in-process (this worker's own).
        if (this.shells.has(rec.shellId)) continue;
        if (groupAlive(rec.pgid)) {
          orphans.push(rec);
          this.registerOrphan(rec, path);
        } else {
          try { rmSync(path, { force: true }); } catch { /* ignore */ }
        }
      }
    }
    return orphans;
  }

  private registerOrphan(rec: PidfileRecord, pidfilePath: string): void {
    // A minimal entry: we have no live child/ring (different process), but
    // ListShells should show it and KillShell should be able to reap it.
    const sh: InternalShell = {
      shellId: rec.shellId,
      sessionId: rec.sessionId,
      command: rec.command,
      cwd: "",
      pgid: rec.pgid,
      status: "orphaned",
      startedAt: rec.startedAt,
      exitCode: null,
      signal: null,
      detectedPort: rec.port,
      agentReadOffset: 0,
      didWrap: false,
      diskAvailable: false,
      child: null,
      // Read the orphan's ALREADY-captured output from its on-disk .log (the
      // live process in the other worker owns/writes it). Opening it read-only
      // surfaces the real tail instead of a fresh EMPTY .orphan ring that made
      // a recovered shell always show "(无输出)". (#7)
      ring: new RingFile(
        join(bgShellsRoot(), rec.sessionId, `${rec.shellId}.log`),
        DISK_CAP_BYTES,
        true,
      ),
      pidfilePath,
      stdoutDec: new StringDecoder("utf-8"),
      stderrDec: new StringDecoder("utf-8"),
      portScanBuf: "",
    };
    this.shells.set(rec.shellId, sh);
  }

  /** Test/reset helper — clears the registry without killing (used in tests). */
  _clear(): void {
    this.shells.clear();
  }

  private toPublic(s: InternalShell): BgShell {
    return {
      shellId: s.shellId,
      sessionId: s.sessionId,
      command: s.command,
      cwd: s.cwd,
      pgid: s.pgid,
      status: s.status,
      startedAt: s.startedAt,
      exitedAt: s.exitedAt,
      exitCode: s.exitCode,
      signal: s.signal,
      detectedPort: s.detectedPort,
      agentReadOffset: s.agentReadOffset,
      totalBytes: s.ring.totalWritten(),
      didWrap: s.didWrap,
      diskAvailable: s.diskAvailable,
    };
  }
}

/** Process-local singleton, mirroring asyncAgentRegistry's lifetime contract. */
export const backgroundShellManager = new BackgroundShellManager();
