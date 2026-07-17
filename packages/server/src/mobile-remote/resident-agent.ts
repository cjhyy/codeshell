import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { pathWithCommonBins } from "./path-bins.js";

/**
 * Normalized event emitted from a resident stream-json claude process. The
 * raw stream-json is collapsed into a small, render-friendly union that the
 * room layer persists to messages.jsonl and mirrors to the phone. System
 * hook/init noise is dropped.
 */
export type ResidentAgentEvent =
  | { type: "text"; text: string }
  // `id` is claude's tool_use block id — threaded through so tool_result can be
  // paired back to its start by id (not the fragile "seal the last open tool"
  // heuristic, which breaks when a turn runs tools in parallel). Optional: old
  // transcripts and malformed lines may lack it.
  // `input` is the FULL tool_use args (e.g. a sub-agent's multi-paragraph
  // `prompt`). `summary` is a lossy one-field preview for compact lists; `input`
  // is what the tool card expands to so the real parameters are visible.
  | { type: "tool"; id?: string; tool: string; summary: string; input?: Record<string, unknown> }
  | { type: "tool_result"; id?: string; summary: string; isError: boolean }
  | { type: "turn_end"; reason: string }
  | { type: "error"; error: string }
  | { type: "exit"; code: number | null; signal: string | null }
  | {
      type: "approval_request";
      requestId: string;
      toolName: string;
      displayName?: string;
      input: unknown;
      description?: string;
    };

/** A decision for a tool-approval (`can_use_tool`) control request. */
export type ControlDecision =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };

/**
 * Build the `control_response` envelope claude expects on stdin for a
 * `can_use_tool` prompt. Pure + exported so the wire shape is unit-testable.
 *
 * Critically: the stdio control protocol's Zod schema requires `updatedInput`
 * to be a RECORD on the allow branch — an allow decision that omits it makes
 * claude reject the whole response (ZodError invalid_union) and the tool
 * silently fails. So we default a missing `updatedInput` to `{}` here, at the
 * single choke point where every decision becomes wire bytes, regardless of
 * which caller (renderer, phone, future code) produced it.
 */
export function buildControlResponse(requestId: string, decision: ControlDecision) {
  const normalized: ControlDecision =
    decision.behavior === "allow"
      ? { behavior: "allow", updatedInput: decision.updatedInput ?? {} }
      : decision;
  return {
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: normalized },
  };
}

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
  if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") {
    return [
      {
        type: "approval_request",
        requestId: String(msg.request_id ?? ""),
        toolName: String(msg.request?.tool_name ?? "tool"),
        displayName:
          typeof msg.request?.display_name === "string" ? msg.request.display_name : undefined,
        input: msg.request?.input,
        description:
          typeof msg.request?.description === "string" ? msg.request.description : undefined,
      },
    ];
  }
  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const c of msg.message.content) {
      if (c.type === "text" && typeof c.text === "string") {
        out.push({ type: "text", text: c.text });
      } else if (c.type === "tool_use") {
        out.push({
          type: "tool",
          id: typeof c.id === "string" ? c.id : undefined,
          tool: c.name ?? "tool",
          summary: argsSummary(c.input),
          input: c.input && typeof c.input === "object" ? c.input : undefined,
        });
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
        out.push({
          type: "tool_result",
          id: typeof c.tool_use_id === "string" ? c.tool_use_id : undefined,
          summary: text.slice(0, 400),
          isError: Boolean(c.is_error),
        });
      }
    }
    return out;
  }
  if (msg.type === "result") {
    out.push({
      type: "turn_end",
      reason: typeof msg.subtype === "string" ? msg.subtype : "completed",
    });
    return out;
  }
  // system (init/hook), rate_limit_event, etc. → ignored noise.
  return out;
}

export interface ResidentAgentOptions {
  command: string; // e.g. "claude"
  cwd: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  resumeSessionId?: string;
  /** Optional host policy appended to the external agent's system prompt. */
  appendSystemPrompt?: string;
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
    const args = [
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
    ];
    if (this.opts.appendSystemPrompt) {
      args.push("--append-system-prompt", this.opts.appendSystemPrompt);
    }
    if (this.opts.resumeSessionId) {
      args.push("--resume", this.opts.resumeSessionId);
    }
    args.push("--permission-mode", this.opts.permissionMode);
    const child = spawn(this.opts.command, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, PATH: pathWithCommonBins() },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
      if (/error/i.test(text))
        this.opts.onEvent({ type: "error", error: text.trim().slice(0, 400) });
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

  /** Reply to a `control_request` (can_use_tool) approval prompt over stdin. */
  respondControl(requestId: string, decision: ControlDecision): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) return;
    this.child.stdin.write(JSON.stringify(buildControlResponse(requestId, decision)) + "\n");
  }

  isRunning(): boolean {
    return Boolean(this.child);
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    // Guard pid > 1: process.kill(-1) would SIGTERM every process the user can
    // reach, and -0 the caller's own group. `!child?.pid` already catches
    // undefined/0; the `> 1` also rules out the (theoretical) pid-1 case so this
    // negative-pid group kill is consistent with killProcessGroup's guard.
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
