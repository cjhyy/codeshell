/**
 * Per-session verbose recorder for local-dev runs.
 *
 * Writes a JSON-lines trace to <repo>/log/<YYYY-MM-DD>/session-<sid>.jsonl
 * containing every step: user input, system prompt, each LLM request+response
 * (full bodies), each tool call's args and result, and engine decision events.
 *
 * Why a separate sink from logger.ts?
 *   - logger.ts is the terse process-wide log (~/.code-shell/logs/) and stays
 *     small for production observability.
 *   - This sink keeps full prompt/response bodies for post-mortem debugging
 *     and is gated to local-dev only (bun run dev / CODE_SHELL_DEV=1).
 *
 * Why JSONL not markdown?
 *   - `jq` can slice on any field in one command: tool histograms, slowest
 *     LLM calls, largest prompts, anything. Markdown would need ad-hoc parsing.
 *   - Field bodies are inlined; JSON.stringify handles arbitrarily long
 *     strings and jq streams, so no sidecar files are needed.
 *
 * Daily rotation: on first write each process, prune date folders older than
 * RETENTION_DAYS.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const RETENTION_DAYS = 7;
// Per-record cap on the inlined tool output/error blob. The recorder is dev
// only, but a stray CODE_SHELL_DEV=1 plus a Read of a large file would write
// the whole file body to disk every run; this caps it.
const MAX_RECORD_BYTES = 256 * 1024;

function clip(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  if (s.length <= MAX_RECORD_BYTES) return s;
  return s.slice(0, MAX_RECORD_BYTES) + `\n…(truncated, ${s.length - MAX_RECORD_BYTES} more bytes)`;
}

function isLocalDev(): boolean {
  if (process.env.CODE_SHELL_VERBOSE_LOG === "0") return false;
  if (process.env.CODE_SHELL_DEV === "1") return true;
  if (process.argv.includes("--debug") || process.argv.includes("-d")) return true;
  if (process.argv.some((a) => a.startsWith("--debug="))) return true;
  if (process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1") return false;
  const entry = process.argv[1] ?? "";
  if (entry.includes(`${"/"}src${"/"}`)) return true;
  return false;
}

const ENABLED = isLocalDev();

// Anchor the log dir at the repo root. We can't trust process.cwd() because
// the CLI may run from any subdirectory; instead walk up from this source
// file looking for package.json. In a published install this file is under
// dist/, which is fine — the recorder is only enabled in dev anyway.
function resolveLogDir(): string {
  let dir = new URL(".", import.meta.url).pathname;
  if (dir.endsWith("/")) dir = dir.slice(0, -1);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return join(dir, "log");
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), "log");
}

const LOG_ROOT = ENABLED ? resolveLogDir() : "";

// Strip secret-bearing flags before persisting argv. Covers both
// `--flag value` and `--flag=value` shapes; case-insensitive match on
// the flag name only (values are never inspected).
const SENSITIVE_FLAG_RE = /^--?(api[-_]?key|auth[-_]?token|token|password|secret|bearer)(=|$)/i;
function redactArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const m = SENSITIVE_FLAG_RE.exec(a);
    if (!m) {
      out.push(a);
      continue;
    }
    if (m[2] === "=") {
      out.push(`${a.slice(0, a.indexOf("=") + 1)}<redacted>`);
    } else {
      out.push(a);
      if (i + 1 < argv.length) {
        out.push("<redacted>");
        i += 1;
      }
    }
  }
  return out;
}

type SidState = { path: string; startedAt: number };
const states = new Map<string, SidState>();
let rotated = false;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function rotateOnce(): void {
  if (rotated || !ENABLED) return;
  rotated = true;
  try {
    if (!existsSync(LOG_ROOT)) return;
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const entry of readdirSync(LOG_ROOT)) {
      const full = join(LOG_ROOT, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory() && st.mtimeMs < cutoff) {
          rmSync(full, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* best-effort */
  }
}

function ensureState(sid: string): SidState | null {
  if (!ENABLED) return null;
  rotateOnce();
  let st = states.get(sid);
  if (st) return st;
  const dateStr = todayStr();
  const dayDir = join(LOG_ROOT, dateStr);
  const path = join(dayDir, `session-${sid}.jsonl`);
  try {
    if (!existsSync(dayDir)) mkdirSync(dayDir, { recursive: true });
  } catch {
    return null;
  }
  st = { path, startedAt: Date.now() };
  states.set(sid, st);
  return st;
}

function write(sid: string, event: Record<string, unknown>): void {
  const st = ensureState(sid);
  if (!st) return;
  const record = { t: new Date().toISOString(), sid, ...event };
  try {
    appendFileSync(st.path, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    /* best-effort */
  }
}

// ─── Public API ────────────────────────────────────────────────────

export function isVerboseRecorderEnabled(): boolean {
  return ENABLED;
}

export function getVerboseLogDir(): string {
  return LOG_ROOT;
}

export function recordSessionStart(
  sid: string,
  info: {
    task?: string;
    cwd?: string;
    model?: string;
    provider?: string;
    permissionMode?: string;
    resumed?: boolean;
  },
): void {
  if (!ENABLED) return;
  write(sid, {
    type: "session_start",
    pid: process.pid,
    argv: redactArgv(process.argv.slice(1)),
    cwd: info.cwd,
    model: info.model,
    provider: info.provider,
    permissionMode: info.permissionMode,
    resumed: info.resumed,
    task: info.task,
  });
}

export type RecordLLMRequest = {
  provider: string;
  model: string;
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  messages: unknown;
  tools?: unknown;
  systemPrompt?: string;
};

export function recordLLMRequest(sid: string, req: RecordLLMRequest, reqId: string): void {
  if (!ENABLED) return;
  write(sid, {
    type: "llm.request",
    reqId,
    provider: req.provider,
    model: req.model,
    stream: req.stream,
    temperature: req.temperature,
    maxTokens: req.maxTokens,
    toolCount: Array.isArray(req.tools) ? (req.tools as unknown[]).length : 0,
    messageCount: Array.isArray(req.messages) ? (req.messages as unknown[]).length : undefined,
    systemPrompt: req.systemPrompt,
    tools: req.tools,
    messages: req.messages,
  });
}

export type RecordLLMResponse = {
  text?: string;
  toolCalls?: Array<{ id: string; toolName: string; args: unknown }>;
  stopReason?: string;
  usage?: import("../types.js").TokenUsage;
  durationMs?: number;
  ttftMs?: number;
};

export function recordLLMResponse(sid: string, resp: RecordLLMResponse, reqId: string): void {
  if (!ENABLED) return;
  write(sid, {
    type: "llm.response",
    reqId,
    stopReason: resp.stopReason,
    durationMs: resp.durationMs,
    ttftMs: resp.ttftMs,
    usage: resp.usage,
    toolCallCount: resp.toolCalls?.length ?? 0,
    text: resp.text,
    toolCalls: resp.toolCalls,
  });
}

export function recordLLMError(sid: string, reqId: string, err: unknown, durationMs: number): void {
  if (!ENABLED) return;
  write(sid, {
    type: "llm.error",
    reqId,
    durationMs,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
}

export function recordToolCall(
  sid: string,
  call: { id: string; toolName: string; args: unknown },
): void {
  if (!ENABLED) return;
  write(sid, {
    type: "tool.call",
    toolCallId: call.id,
    toolName: call.toolName,
    args: call.args,
  });
}

export function recordToolResult(
  sid: string,
  result: {
    id: string;
    toolName: string;
    ok: boolean;
    durationMs: number;
    output?: string;
    error?: string;
  },
): void {
  if (!ENABLED) return;
  write(sid, {
    type: "tool.result",
    toolCallId: result.id,
    toolName: result.toolName,
    ok: result.ok,
    durationMs: result.durationMs,
    chars: (result.output ?? result.error ?? "").length,
    output: clip(result.output),
    error: clip(result.error),
  });
}

export function recordEvent(
  sid: string,
  name: string,
  data?: Record<string, unknown>,
): void {
  if (!ENABLED) return;
  write(sid, { type: name, ...(data ?? {}) });
}

export function recordSessionEnd(
  sid: string,
  info: { reason?: string; turns?: number; cost?: unknown; durationMs?: number },
): void {
  if (!ENABLED) return;
  write(sid, {
    type: "session_end",
    reason: info.reason,
    turns: info.turns,
    durationMs: info.durationMs,
    cost: info.cost,
  });
  states.delete(sid);
}

