import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ResidentAgentEvent } from "./resident-agent.js";
import { pathWithCommonBins } from "./path-bins.js";
import { parseCodexJsonLine, extractThreadId } from "./codex-parse.js";
import type { RoomAgent } from "./room-manager.js";

type RoomPermissionMode = "default" | "acceptEdits" | "bypassPermissions";

/** Map a room permission mode to codex's spawn-time sandbox tier. codex has no
 *  per-tool approval; the tier IS the guardrail. (Mirrors core's codexAdapter.) */
export function sandboxForMode(mode: RoomPermissionMode): { bypass: boolean; sandbox?: "read-only" | "workspace-write" } {
  if (mode === "bypassPermissions") return { bypass: true, sandbox: undefined };
  return { bypass: false, sandbox: mode === "acceptEdits" ? "workspace-write" : "read-only" };
}

/** Build `codex exec` argv for one turn. Prompt is fed over stdin (trailing `-`).
 *  Pure → unit-testable. */
export function codexArgsForTurn(opts: { mode: RoomPermissionMode; threadId?: string }): string[] {
  const args = ["exec", "--json", "--color", "never", "--skip-git-repo-check"];
  const { bypass, sandbox } = sandboxForMode(opts.mode);
  if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (sandbox) args.push("--sandbox", sandbox);
  if (opts.threadId) args.push("resume", opts.threadId, "-");
  else args.push("-");
  return args;
}

/**
 * Decide whether a finished codex turn should surface a stderr-based error.
 * Pure → unit-testable.
 *
 * codex `exec --json` reports most failures as `turn.failed`/`error` JSON on
 * STDOUT (handled by parseCodexJsonLine), but some (e.g. resuming a missing
 * thread id, arg-parse failures) print ONLY to stderr with a non-zero exit and
 * no JSON. So we report stderr as an error *only when the process actually
 * failed* (non-zero exit). On a clean exit, stderr is just warnings/notices and
 * must NOT become a red error in the room. Operating on full lines (not raw
 * chunks) avoids a chunk split mid-line being mis-judged.
 */
export function codexStderrError(stderrLines: string[], exitCode: number | null): string | null {
  if (exitCode === 0 || exitCode === null) return null;
  const text = stderrLines.join("\n").trim();
  if (!text) return null;
  return text.slice(0, 800);
}

/**
 * Decide whether a finished codex turn needs a FALLBACK seal event so the room
 * UI doesn't hang on "working". Pure → unit-testable.
 *
 * The room is sealed (turn_end / error) the moment a `turn.completed` or
 * `turn.failed` JSON line arrives on stdout. But a codex process can die WITHOUT
 * emitting either — OOM-killed, segfaulted, or non-zero exit with output only
 * half-written — and then nothing tells the reducer the turn is over: the
 * progress card spins forever. This function returns the event the exit handler
 * must emit in that gap.
 *
 * Cases:
 *   - already sealed (turn JSON seen)        → null (don't double-seal)
 *   - user stopped the room                  → null (stop() tears down the UI)
 *   - a stderr error will be emitted          → null (that error seals the run)
 *   - otherwise (crash / silent exit)         → a turn_end so the UI settles.
 *     reason encodes how it ended for the transcript.
 */
export function sealEventOnExit(opts: {
  code: number | null;
  signal: NodeJS.Signals | null;
  turnSealed: boolean;
  stopping: boolean;
  hasStderrError: boolean;
}): ResidentAgentEvent | null {
  if (opts.turnSealed || opts.stopping || opts.hasStderrError) return null;
  const reason =
    opts.signal != null
      ? `killed:${opts.signal}`
      : opts.code && opts.code !== 0
        ? `exited:${opts.code}`
        : "completed";
  return { type: "turn_end", reason };
}

export interface CodexRoomAgentOptions {
  command: string; // e.g. "codex"
  cwd: string;
  permissionMode: RoomPermissionMode;
  /** Resume an existing codex thread (across app restarts). */
  resumeThreadId?: string;
  onEvent: (event: ResidentAgentEvent) => void;
  /** Surfaced when codex mints/confirms its thread id, so the room can persist
   *  it for resume on the next turn / after restart. */
  onThreadId?: (threadId: string) => void;
}

/**
 * A codex-backed room agent. Unlike the claude resident process (one long-lived
 * stdin-fed process), codex `exec` runs ONE process per turn and the next turn
 * continues the conversation via `resume <thread_id>`. So `send()` spawns a
 * fresh `codex exec` each time, capturing the thread id from the first turn and
 * resuming it thereafter. Implements the same RoomAgent interface so RoomManager
 * treats it identically; it has no `respondControl` (codex has no per-tool
 * approval — the sandbox tier is the guardrail).
 */
export class CodexRoomAgent implements RoomAgent {
  private child?: ChildProcess;
  private threadId?: string;
  private started = false;
  /** True once the CURRENT turn emitted a sealing event (turn_end via
   *  turn.completed, or an error). Reset at the start of each send(). */
  private turnSealed = false;
  /** True while stop() is tearing the room down, so the exit handler doesn't
   *  mistake an intentional SIGTERM for a crash. */
  private stopping = false;

  constructor(private readonly opts: CodexRoomAgentOptions) {
    this.threadId = opts.resumeThreadId;
  }

  /** No persistent process to launch; a turn's process is spawned on send(). */
  start(): void {
    this.started = true;
  }

  send(text: string): boolean {
    if (!this.started) return false;
    if (this.child) return false; // a turn is already running; one turn at a time
    this.turnSealed = false; // fresh turn — not yet sealed
    const args = codexArgsForTurn({ mode: this.opts.permissionMode, threadId: this.threadId });
    const child = spawn(this.opts.command, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, PATH: pathWithCommonBins() },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    // Feed the user's prompt over stdin (codex exec reads it because argv ends `-`).
    child.stdin?.end(text);

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        // Capture the thread id (parseCodexJsonLine intentionally drops
        // thread.started — it's resume-control info, not a render event) so we
        // can resume on the next turn and persist it across restarts.
        const tid = extractThreadId(line);
        if (tid) {
          this.threadId = tid;
          this.opts.onThreadId?.(tid);
        }
        for (const ev of parseCodexJsonLine(line)) {
          // turn_end / error are the reducer's sealing events — once one fires
          // for this turn, the exit handler need not synthesize a fallback.
          if (ev.type === "turn_end" || ev.type === "error") this.turnSealed = true;
          this.opts.onEvent(ev);
        }
      });
    }
    // Accumulate stderr by LINE; only surface it as an error if the turn exits
    // non-zero (see codexStderrError). Per-chunk `/error/i` matching produced
    // spurious red errors from non-fatal warnings and could misjudge a line
    // split across chunks.
    const stderrLines: string[] = [];
    if (child.stderr) {
      const errRl = createInterface({ input: child.stderr });
      errRl.on("line", (line) => stderrLines.push(line));
    }
    child.on("error", (err) => {
      const isMissing = (err as NodeJS.ErrnoException).code === "ENOENT";
      this.turnSealed = true; // this error seals the run in the reducer
      this.opts.onEvent({
        type: "error",
        error: isMissing
          ? `未找到命令 "${this.opts.command}"。请先安装 Codex CLI 并确保它在 PATH 中。`
          : err.message,
      });
      this.child = undefined;
    });
    child.on("exit", (code, signal) => {
      // The turn's process is done; the room stays "running" (ready for the next
      // turn). We do NOT emit `exit` here — that would tear the room down in the
      // UI after every turn. turn.completed already produced a `turn_end`.
      // A non-zero exit whose error went only to stderr (no turn.failed JSON)
      // is surfaced now so the room shows *why* it failed.
      const stderrErr = codexStderrError(stderrLines, code);
      if (stderrErr) {
        this.turnSealed = true;
        this.opts.onEvent({ type: "error", error: stderrErr });
      }
      // FALLBACK SEAL (#6): if the process died without ever sealing the turn
      // (no turn.completed / turn.failed JSON, no stderr error) and we didn't
      // stop it ourselves, the room UI would hang on "working" forever. Emit a
      // synthetic turn_end so the progress card settles.
      const seal = sealEventOnExit({
        code,
        signal,
        turnSealed: this.turnSealed,
        stopping: this.stopping,
        hasStderrError: stderrErr != null,
      });
      if (seal) this.opts.onEvent(seal);
      this.child = undefined;
    });
    return true;
  }

  /** The room is "running" once started — independent of whether a turn's
   *  process is currently alive (turns are ephemeral). */
  isRunning(): boolean {
    return this.started;
  }

  stop(): void {
    this.started = false;
    this.stopping = true; // the upcoming SIGTERM exit is intentional, not a crash
    const child = this.child;
    this.child = undefined;
    if (!child?.pid || child.pid <= 1) {
      child?.kill("SIGTERM");
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}
