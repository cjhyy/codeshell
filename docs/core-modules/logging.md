# logging

**One-line role.** Process-wide structured (JSON Lines) logger with spans, secret/image redaction, session-id propagation, and an optional dev-only per-session verbose recorder.

## 职责 / Responsibility

This module is the single observability surface for core. It owns: (1) a terse, always-on file logger that routes entries into two daily buckets under `~/.code-shell/logs/` — `ui-ink-*.log` (UI/render chatter) and `engine-*.log` (everything else); (2) redaction of secrets and image base64 payloads so nothing sensitive lands in logs or diagnostics; and (3) a fat, dev-only `session-recorder` that writes full prompt/response/tool bodies into `<repo>/log/<date>/{engine,ui}/session-<sid>.jsonl` for post-mortem debugging. Transcripts (replay data) are out of scope — they keep full bytes; this module only governs what reaches *logs*.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `logger.ts` | The `logger` singleton, `Logger` class, spans, session-id (ALS + fallback) resolution, file routing/rotation, in-memory error ring. Main entry point. |
| `sanitize-messages.ts` | Pure redaction helpers: `redactSecrets` (deep clone, scrubs API keys/Bearer/token URL params), `sanitizeContent`/`sanitizeMessages` (strip image base64 → metadata stub), `sanitizeTaskString` (strip `<codeshell-image>` data URLs). |
| `session-recorder.ts` | Dev-only verbose sink. `record*` functions write JSONL per session; no-op unless local-dev. |

## 公开接口 / Public API

From `logger.ts` (re-exported via core `index.ts` as `logger`, `rotateLogs`):

```ts
export const logger: Logger;                       // process-wide singleton
type LogLevel = "debug" | "info" | "warn" | "error";
interface LogContext { cat?: string; sid?: string; [k: string]: unknown }

class Logger {
  child(extra: LogContext): Logger;                // tag a sub-logger with cat/fields
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msgOrErr: string | Error | unknown, data?: Record<string, unknown> | Error): void;
  span(name: string, data?: Record<string, unknown>): LogSpan;  // begin/end+duration_ms
}
interface LogSpan { end(extra?): void; fail(err: unknown, extra?): void }

// Session-id propagation (used by Engine.run):
function runWithSid<T>(sid: string, fn: () => T | Promise<T>): T | Promise<T>;
function enterSid(sid: string): void;              // bind sid to current async ctx (no callback)
function setCurrentSid(sid: string): void;         // module-global fallback
function getCurrentSid(): string;                  // ALS value, else fallback

// Sink redirection / maintenance:
function setLogsDir(dir: string | null): void;     // null → default ~/.code-shell/logs
function getLogsDir(): string;
function getRecentLogs(n?: number): string[];      // merge+sort today's buckets
function rotateLogs(): void;                        // prune to MAX_LOG_FILES (7)
function getInMemoryErrors(): ReadonlyArray<{ msg; t; data? }>;
function attachErrorLogSink(sink: ErrorLogSink): void;
```

From `sanitize-messages.ts`:

```ts
function redactSecrets<T>(value: T, depth?: number): T;        // deep clone, pure
function sanitizeContent(content: Message["content"]): Message["content"];
function sanitizeMessages(messages: readonly Message[]): Message[];
function sanitizeTaskString(task: string): string;
```

From `session-recorder.ts` (all no-op outside local-dev):

```ts
function isVerboseRecorderEnabled(): boolean;
function recordSessionStart(sid, { task?, cwd?, model?, provider?, permissionMode?, resumed? }): void;
function recordSessionEnd(sid, { reason?, turns?, cost?, durationMs? }): void;
function recordLLMRequest(sid, req: RecordLLMRequest, reqId: string): void;
function recordLLMResponse(sid, resp: RecordLLMResponse, reqId: string): void;
function recordLLMError(sid, reqId, err, durationMs): void;
function recordToolCall(sid, { id, toolName, args }): void;
function recordToolResult(sid, { id, toolName, ok, durationMs, output?, error? }): void;
function recordEvent(sid, name, data?): void;
function recordUIEvent(sid, name, data?): void;     // re-exported from core index.ts
```

## 怎么用 / How to use

Logging with a category and a timed span (from `tool-system/executor.ts`):

```ts
import { logger as rootLogger, getCurrentSid } from "../logging/logger.js";
import { recordToolCall, recordToolResult } from "../logging/session-recorder.js";

const log = rootLogger.child({ cat: "tool" });          // tags every line with cat:"tool"

const span = log.span("tool.exec", {
  cat: "tool",
  tool: call.toolName,
  toolCallId: call.id,
  args: JSON.stringify(call.args).slice(0, 2000),
});
const sid = getCurrentSid();
recordToolCall(sid, { id: call.id, toolName: call.toolName, args: call.args });
try {
  const result = await registry.executeTool(...);
  span.end({ ok: true });                               // writes tool.exec.end + duration_ms
  recordToolResult(sid, { id: call.id, toolName: call.toolName, ok: true, durationMs, output });
} catch (err) {
  span.fail(err);                                        // writes tool.exec.fail + duration_ms
  recordToolResult(sid, { id: call.id, toolName: call.toolName, ok: false, durationMs, error });
}
```

Scoping a whole run to one session id so every nested async log line is stamped (from `engine/engine.ts`):

```ts
import { runWithSid } from "../logging/logger.js";
import { recordSessionStart } from "../logging/session-recorder.js";

return runWithSid(session.state.sessionId, async () => {
  recordSessionStart(session.state.sessionId, {
    cwd, model, provider, permissionMode, resumed, task,
  });
  // ... all turns run here; logger.info/debug pick up the sid automatically
});
```

## 注意 / Gotchas

- **File routing is by `cat`, not by API.** Only `cat ∈ {ui, ink, render, stream}` lands in the `ui-ink` bucket; everything else goes to `engine`. Set `cat` via `logger.child({ cat })` or in the per-call `data`.
- **`span()` levels are fixed:** `.begin` is `debug`, `.end` is `info`, `.fail` is `error`. The `--debug=<cat>` category filter only narrows the *debug* firehose — info/warn/error always pass.
- **Session id has two layers.** Prefer `runWithSid`/`enterSid` (AsyncLocalStorage — concurrent parent/child Engines coexist without racing). `setCurrentSid` is only a module-global fallback for code with no ALS scope. The sid is stamped at *write* time, so a `child()` created before `Engine.run` still gets the real sid.
- **Everything is best-effort and silent on failure.** File writes are wrapped in `try/catch {}`. Redaction happens at the write boundary — `msg` and `data` are run through `redactSecrets` before serialization, so callers don't redact by hand.
- **`session-recorder` is dev-only.** Every `record*` function is a no-op unless local-dev is detected (`CODE_SHELL_DEV=1`, `--debug`, or running from `src/`); `CODE_SHELL_VERBOSE_LOG=0` force-disables. Don't rely on it in production. It also caps per-record blobs at 256 KB.
- **Redaction is for logs only, never transcripts.** `sanitizeMessages`/`redactSecrets` return new values and never mutate input precisely because the same object may also be heading to a transcript or UI stream where the unredacted form is required.
- **Env knobs:** `CODE_SHELL_LOG=0` disables the logger entirely; `CODE_SHELL_LOG_LEVEL` overrides level; `CODE_SHELL_DEBUG=1` echoes to stderr (also `--debug-to-stderr`/`-d2e`); `CODE_SHELL_DEBUG=mcp,api` / `--debug=mcp,api` set the category filter.
- **Hosts redirect via `setLogsDir`.** Electron renderer / headless / tests call `setLogsDir(dir)` (or `null` to reset) before any log activity, since reads (`getLogsDir`, `getRecentLogs`) go through the same indirection.
- **Must rebuild core** for `dist`-importing hosts (TUI/desktop) to see changes here.
