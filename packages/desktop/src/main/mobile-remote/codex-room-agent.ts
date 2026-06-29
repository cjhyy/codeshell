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
        for (const ev of parseCodexJsonLine(line)) this.opts.onEvent(ev);
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
      this.opts.onEvent({
        type: "error",
        error: isMissing
          ? `未找到命令 "${this.opts.command}"。请先安装 Codex CLI 并确保它在 PATH 中。`
          : err.message,
      });
      this.child = undefined;
    });
    child.on("exit", (code) => {
      // The turn's process is done; the room stays "running" (ready for the next
      // turn). We do NOT emit `exit` here — that would tear the room down in the
      // UI after every turn. turn.completed already produced a `turn_end`.
      // A non-zero exit whose error went only to stderr (no turn.failed JSON)
      // is surfaced now so the room shows *why* it failed.
      const stderrErr = codexStderrError(stderrLines, code);
      if (stderrErr) this.opts.onEvent({ type: "error", error: stderrErr });
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
