import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { delimiter } from "node:path";

/**
 * Normalized event emitted from a resident stream-json claude process. The
 * raw stream-json is collapsed into a small, render-friendly union that the
 * room layer persists to messages.jsonl and mirrors to the phone. System
 * hook/init noise is dropped.
 */
export type ResidentAgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; summary: string }
  | { type: "tool_result"; summary: string; isError: boolean }
  | { type: "turn_end"; reason: string }
  | { type: "error"; error: string }
  | { type: "exit"; code: number | null; signal: string | null };

const TOOL_SUMMARY_KEYS = ["command", "file_path", "path", "url", "pattern", "query"];

function argsSummary(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const k of TOOL_SUMMARY_KEYS) {
    const v = input[k];
    if (typeof v === "string") return v;
  }
  return "";
}

/**
 * Parse ONE line of claude stream-json output into zero-or-more normalized
 * events. Returns [] for lines we intentionally ignore (system/init/hook/
 * rate_limit) or unparseable lines. Pure + synchronous so it is unit-testable
 * against recorded output without spawning claude.
 */
export function parseStreamJsonLine(line: string): ResidentAgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const out: ResidentAgentEvent[] = [];
  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const c of msg.message.content) {
      if (c.type === "text" && typeof c.text === "string") {
        out.push({ type: "text", text: c.text });
      } else if (c.type === "tool_use") {
        out.push({ type: "tool", tool: c.name ?? "tool", summary: argsSummary(c.input) });
      }
    }
    return out;
  }
  if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const c of msg.message.content) {
      if (c.type === "tool_result") {
        const text = Array.isArray(c.content)
          ? c.content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
          : typeof c.content === "string"
            ? c.content
            : "";
        out.push({ type: "tool_result", summary: text.slice(0, 400), isError: Boolean(c.is_error) });
      }
    }
    return out;
  }
  if (msg.type === "result") {
    out.push({ type: "turn_end", reason: typeof msg.subtype === "string" ? msg.subtype : "completed" });
    return out;
  }
  // system (init/hook), rate_limit_event, etc. → ignored noise.
  return out;
}

/**
 * macOS GUI-launched Electron has a minimal PATH (no Homebrew). Prepend common
 * CLI dirs so `claude` resolves. Mirrors the external-agent adapter's fix.
 */
function pathWithCommonBins(env: NodeJS.ProcessEnv = process.env): string {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const current = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const merged: string[] = [];
  for (const dir of [...extra, ...current]) if (!merged.includes(dir)) merged.push(dir);
  return merged.join(delimiter);
}

export interface ResidentAgentOptions {
  command: string; // e.g. "claude"
  cwd: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  onEvent: (event: ResidentAgentEvent) => void;
}

/**
 * A long-lived claude process in stream-json mode. Feed user turns via send();
 * normalized events arrive on onEvent. Context is continuous for the lifetime
 * of the process (same conversation). Stopped explicitly via stop().
 */
export class ResidentAgentProcess {
  private child?: ChildProcess;

  constructor(private readonly opts: ResidentAgentOptions) {}

  start(): void {
    if (this.child) return;
    const child = spawn(
      this.opts.command,
      [
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--permission-mode",
        this.opts.permissionMode,
      ],
      {
        cwd: this.opts.cwd,
        env: { ...process.env, PATH: pathWithCommonBins() },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        for (const ev of parseStreamJsonLine(line)) this.opts.onEvent(ev);
      });
    }
    child.stderr?.on("data", (chunk) => {
      // claude prints non-fatal warnings to stderr; surface as error events
      // only if they look like real errors (cheap heuristic).
      const text = String(chunk);
      if (/error/i.test(text)) this.opts.onEvent({ type: "error", error: text.trim().slice(0, 400) });
    });
    child.on("error", (err) => {
      const isMissing = (err as NodeJS.ErrnoException).code === "ENOENT";
      this.opts.onEvent({
        type: "error",
        error: isMissing
          ? `未找到命令 "${this.opts.command}"。请先安装 Claude Code CLI 并确保它在 PATH 中。`
          : err.message,
      });
    });
    child.on("exit", (code, signal) => {
      this.child = undefined;
      this.opts.onEvent({ type: "exit", code, signal });
    });
  }

  /** Feed one user turn. Returns false if the process isn't running. */
  send(text: string): boolean {
    if (!this.child?.stdin || this.child.stdin.destroyed) return false;
    const line = JSON.stringify({ type: "user", message: { role: "user", content: text } });
    this.child.stdin.write(line + "\n");
    return true;
  }

  isRunning(): boolean {
    return Boolean(this.child);
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    if (!child?.pid) return;
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
