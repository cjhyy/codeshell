/**
 * shell-runner — execute a user-configured shell command as a hook handler.
 *
 * Protocol (matches Claude Code's shell-hook contract):
 *
 *   stdin       JSON.stringify({ eventName, data }) — the full HookContext
 *               envelope, including ctx.data fields like toolName / args /
 *               sessionId / isSubAgent.
 *
 *   stdout      Either ignored (when exit 0 with no/blank output) or parsed
 *               as a HookResult JSON document. Unparseable stdout on exit 0
 *               is logged at warn level and dropped — we do NOT crash the
 *               turn loop on malformed handler output.
 *
 *   exit  0     Normal return. Stdout (if any) becomes the HookResult.
 *   exit  2     Deny / block. Stderr becomes the human-readable reason and
 *               is surfaced to the model via HookResult.messages so the LLM
 *               sees why the action was rejected.
 *   exit  *     Any other non-zero code = handler error. Logged at error
 *               level; we return {} (no effect) so a buggy hook never wedges
 *               the engine.
 *
 *   ENV (passed to child):
 *               CODESHELL_HOOK_EVENT   — event name, also in stdin
 *               CODESHELL_HOOK_CWD     — repo root for context-aware hooks
 *               (callers may add more by reading process.env directly)
 *
 *   timeout     Defaults to 60_000 ms; settings.timeout_ms overrides.
 *               On timeout we SIGTERM then SIGKILL, log, and return {}.
 */

import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { HookContext, HookResult } from "./events.js";
import type { SettingsHookConfig } from "../types.js";
import { MAX_HOOK_OUTPUT_BYTES, validateHookResult } from "./hook-output.js";
import { killChildTree } from "../runtime/spawn-common.js";

// Re-export so existing call sites that import { validateHookResult } from
// "./shell-runner.js" (e.g. tests) keep compiling.
export { validateHookResult };

const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_HOOK_STDIN_BYTES = 256 * 1024;

export interface HookStdinFailure {
  type: "stdin_error";
  code: string;
  message: string;
}

export function stdinFailure(error: unknown): HookStdinFailure {
  const err = error as NodeJS.ErrnoException;
  return {
    type: "stdin_error",
    code: typeof err?.code === "string" ? err.code : "UNKNOWN",
    message: err instanceof Error ? err.message : String(error),
  };
}

/**
 * Codes meaning the hook's read end is gone: it closed stdin or already exited.
 * Hooks may ignore stdin (most CC hooks do), and whether the envelope lands
 * before such a hook exits is a scheduling race on every runtime, so these are
 * not hook failures: the exit status and stdout decide the result. Otherwise a
 * fast `echo reason >&2; exit 2` deny hook could fail open.
 */
const HOOK_STDIN_READER_GONE = new Set([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

export function isHookStdinReaderGone(failure: HookStdinFailure): boolean {
  return HOOK_STDIN_READER_GONE.has(failure.code);
}

function stdinStreamError(code: string, message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

/**
 * Write one hook envelope without leaving a Writable `error` event unhandled.
 *
 * Runtimes disagree on where a broken pipe surfaces: Node reports it to the
 * write callback, the end callback and an `error` event; Bun 1.4 reports a
 * successful write, then fails the end callback and emits `error`. The promise
 * settles with the first error from any of the three (or a close before end()
 * completed) and resolves only once the end callback succeeds. The `error`
 * listener is never removed, so an `error` emitted after settlement is still
 * handled.
 */
export function writeHookStdin(
  stdin: Writable | null | undefined,
  envelope: string,
): Promise<void> {
  if (!stdin) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let writeComplete = false;
    let drained = false;
    let ending = false;

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      stdin.off("drain", onDrain);
      stdin.off("close", onClose);
      if (error != null) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(error);
    const onClose = () =>
      finish(
        stdinStreamError("ERR_STREAM_PREMATURE_CLOSE", "hook stdin closed before end completed"),
      );
    const onDrain = () => {
      drained = true;
      maybeEnd();
    };
    const maybeEnd = () => {
      if (!writeComplete || !drained || ending || settled) return;
      ending = true;
      try {
        stdin.end((error?: Error | null) => finish(error ?? undefined));
      } catch (error) {
        finish(error);
      }
    };

    // EventEmitter treats an unhandled stream `error` as fatal. Register the
    // handler before the first byte is handed to the child, and keep it.
    stdin.on("error", onError);
    stdin.once("close", onClose);
    if (stdin.destroyed) {
      finish(stdinStreamError("ERR_STREAM_DESTROYED", "hook stdin was already destroyed"));
      return;
    }
    try {
      drained = stdin.write(envelope, (error?: Error | null) => {
        if (error) {
          finish(error);
          return;
        }
        writeComplete = true;
        maybeEnd();
      });
      if (!drained) stdin.once("drain", onDrain);
      maybeEnd();
    } catch (error) {
      finish(error);
    }
  });
}

/** Close stdin for an oversized envelope while still absorbing stream errors. */
export function closeHookStdin(stdin: Writable | null | undefined): void {
  if (!stdin) return;
  stdin.on("error", () => {});
  try {
    stdin.end();
  } catch {
    // No envelope was written; the hook is still allowed to run without args.
  }
}

/**
 * Run one shell-hook command and return the parsed HookResult. Catches
 * every failure mode (spawn error, timeout, malformed JSON) and
 * returns an empty result so the registry's chain keeps going.
 */
export async function runShellHook(
  config: SettingsHookConfig,
  ctx: HookContext,
  abortSignal?: AbortSignal,
): Promise<HookResult> {
  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const signal = abortSignal ?? (ctx.data.signal as AbortSignal | undefined);
  if (signal?.aborted) return {};

  return new Promise<HookResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(config.command, [], {
        shell: true,
        cwd: config.cwd,
        env: {
          ...process.env,
          CODESHELL_HOOK_EVENT: ctx.eventName,
          CODESHELL_HOOK_CWD: config.cwd ?? process.cwd(),
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[hooks] spawn failed for ${config.event} command "${config.command}":`,
        (err as Error).message,
      );
      resolve({});
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (value: HookResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };

    const onAbort = () => {
      killChildTree(child, 1000);
      settle({});
    };

    timer = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn(
        `[hooks] ${config.event} hook timed out after ${timeoutMs}ms: ${config.command}`,
      );
      // win32: taskkill /T reaps the shell tree; POSIX: SIGTERM → grace →
      // SIGKILL (a graceful handler gets a moment to flush). See killChildTree.
      killChildTree(child, 1000);
      settle({});
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    // Byte cap: once we cross MAX_HOOK_OUTPUT_BYTES on stdout, kill the
    // child and surface a 'cap exceeded' failure. A misbehaving handler
    // can otherwise hold the engine memory hostage while we accumulate
    // its output. Stderr is also capped but treated more leniently —
    // truncated, not fatal — since stderr is just diagnostic chatter.
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutCapped = false;
    let stderrCapped = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_HOOK_OUTPUT_BYTES) {
        if (!stdoutCapped) {
          stdoutCapped = true;
          // eslint-disable-next-line no-console
          console.warn(
            `[hooks] ${config.event} hook stdout exceeded ${MAX_HOOK_OUTPUT_BYTES} bytes — killing`,
          );
          killChildTree(child, 1000);
        }
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Count raw bytes (not decoded string length) so multibyte UTF-8 output
      // can't slip past the cap — matches the stdout accounting above.
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_HOOK_OUTPUT_BYTES) {
        if (!stderrCapped) {
          stderrCapped = true;
          stderr += "\n…[stderr truncated]";
        }
        return;
      }
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      // eslint-disable-next-line no-console
      console.error(`[hooks] ${config.event} hook failed: ${config.command}`, err.message);
      settle({});
    });

    let stdinFinished = false;
    let pendingClose: { code: number | null } | undefined;
    const handleClose = (code: number | null) => {
      if (stdoutCapped) {
        // eslint-disable-next-line no-console
        console.error(
          `[hooks] ${config.event} hook killed due to oversized stdout (> ${MAX_HOOK_OUTPUT_BYTES} bytes)`,
        );
        settle({});
        return;
      }
      if (code === 0) {
        const trimmed = stdout.trim();
        if (trimmed.length === 0) {
          settle({});
          return;
        }
        try {
          const parsed = JSON.parse(trimmed);
          const validated = validateHookResult(parsed);
          if (validated) {
            settle(validated);
          } else {
            // eslint-disable-next-line no-console
            console.warn(
              `[hooks] ${config.event} hook returned a value that failed HookResult schema, ignoring. stdout:`,
              trimmed.slice(0, 200),
            );
            settle({});
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[hooks] ${config.event} hook returned malformed JSON, ignoring:`,
            (err as Error).message,
            "\nstdout:",
            trimmed.slice(0, 200),
          );
          settle({});
        }
        return;
      }
      if (code === 2) {
        const reason = stderr.trim() || "denied (exit 2)";
        settle({
          decision: "deny",
          messages: [reason],
        });
        return;
      }
      // Other non-zero codes: handler error. Log and treat as no-op so
      // the chain continues. Per CC: stderr is surfaced to the user but
      // doesn't block execution.
      // eslint-disable-next-line no-console
      console.error(`[hooks] ${config.event} hook exited with code ${code}:`, stderr.slice(0, 500));
      settle({});
    };
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (settled) return;
      // If close wins the event-loop race, wait for stdin's callback/error so
      // an EPIPE cannot be overwritten by an apparently clean child exit.
      if (!stdinFinished && !stdoutCapped) {
        pendingClose = { code };
        return;
      }
      handleClose(code);
    });

    const finishStdin = () => {
      stdinFinished = true;
      if (pendingClose && !settled) {
        const { code } = pendingClose;
        pendingClose = undefined;
        handleClose(code);
      }
    };

    let envelope: string;
    try {
      envelope = JSON.stringify({ eventName: ctx.eventName, data: ctx.data });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[hooks] failed to serialize stdin for ${config.event}:`,
        error instanceof Error ? error.message : String(error),
      );
      settle({});
      return;
    }
    if (Buffer.byteLength(envelope, "utf8") > MAX_HOOK_STDIN_BYTES) {
      // eslint-disable-next-line no-console
      console.warn(
        `[hooks] ${config.event} hook stdin exceeded ${MAX_HOOK_STDIN_BYTES} bytes; running without envelope`,
      );
      closeHookStdin(child.stdin);
      finishStdin();
      return;
    }

    // Write on the next turn so a spawn error or abort that already settled
    // skips it. A hook that stops reading (or exits) before the envelope lands
    // is judged by its exit status; see isHookStdinReaderGone.
    setImmediate(() => {
      void (async () => {
        if (settled) return;
        try {
          await writeHookStdin(child.stdin, envelope);
          finishStdin();
        } catch (error) {
          const failure = stdinFailure(error);
          if (isHookStdinReaderGone(failure)) {
            finishStdin();
            return;
          }
          clearTimeout(timer);
          // eslint-disable-next-line no-console
          console.error(`[hooks] failed to write stdin for ${config.event}:`, failure.message);
          killChildTree(child, 1000);
          settle({ data: { hookFailure: failure } });
        }
      })();
    });
  });
}

/**
 * Check whether the hook should fire for the current ctx, respecting
 * the optional `matcher` regex. Returns false for non-tool events
 * when matcher is set (matcher only makes sense when ctx.data has a
 * toolName field).
 */
export function shellHookMatches(config: SettingsHookConfig, ctx: HookContext): boolean {
  if (!config.matcher) return true;
  const toolName = ctx.data.toolName;
  if (typeof toolName !== "string") return false;
  try {
    return new RegExp(config.matcher).test(toolName);
  } catch {
    // Bad regex in user config — log once, treat as non-matching.
    // eslint-disable-next-line no-console
    console.warn(`[hooks] invalid matcher "${config.matcher}" for ${config.event}; skipping`);
    return false;
  }
}
