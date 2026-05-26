/**
 * SafeSpawn — unified subprocess lifecycle wrapper.
 *
 * Responsibilities:
 *   1. Optional sandbox wrap (Seatbelt / bubblewrap) via {@link SandboxBackend}.
 *   2. UTF-8 IO drain via {@link StringDecoder} (no half-character corruption
 *      when a multi-byte sequence spans two `data` events).
 *   3. Per-stream byte cap with a `truncated` flag (no unbounded buffer fill).
 *   4. `ctx.signal` abort cascade — SIGTERM, then SIGKILL after
 *      `ioDrainGraceMs` (default 100ms). This is the snappy path because
 *      the user is waiting on the cancel.
 *   5. Hard timeout — SIGTERM, then SIGKILL after 2s. Longer grace because
 *      we expect the child to be wedged.
 *   6. Listener cleanup on every exit path (no MaxListeners leak across a
 *      long session that reuses one AbortSignal across many spawns).
 *
 * Explicit non-goals:
 *
 *   - Permission classification. {@link ToolExecutor} already classifies
 *     builtin tools BEFORE the tool function runs; re-classifying here
 *     would double-prompt. Install/marketplace paths (gitOps) are consented
 *     at user-initiated install time; see docs/architecture/17.
 *   - Retries. The caller decides retry policy if any.
 *   - Output formatting. SafeSpawn returns structured fields and lets the
 *     caller compose its own user-facing string (Bash's "STDERR:\n…" /
 *     "Exit code: N" / "Killed by signal: X" formatting lives in bash.ts;
 *     REPL/PowerShell have their own messages).
 *
 * Two entry points, both share the same internal lifecycle:
 *   - {@link safeSpawn}(file, args, opts) — direct argv spawn. Use from
 *     REPL, PowerShell, gitOps where the binary + args are known.
 *   - {@link safeSpawnShell}(command, opts) — runs `command` through the
 *     sandbox backend (or a plain shell if no sandbox). Use from Bash
 *     where the LLM provides a free-form shell string.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { SandboxBackend } from "../tool-system/sandbox/index.js";

export interface SafeSpawnOptions {
  /** Process working directory. Required — callers know their cwd; SafeSpawn does not fall back to process.cwd(). */
  cwd: string;
  /** Environment for the child. Required — callers decide whether to forward host env (Bash builds a hardened env; REPL/PowerShell/gitOps forward process.env). */
  env: NodeJS.ProcessEnv;
  /** Hard timeout in ms. On expiry: SIGTERM, then SIGKILL after 2s. */
  timeoutMs: number;
  /** Per-stream max bytes captured. Stream output beyond this is dropped and a `truncated` flag is set. Default {@link DEFAULT_MAX_OUTPUT_BYTES}. */
  maxOutputBytes?: number;
  /**
   * Grace period after SIGTERM before SIGKILL when ABORTING via ctx.signal.
   * Defaults to {@link DEFAULT_IO_DRAIN_GRACE_MS}. The timeout path uses a
   * fixed 2s grace because the caller has been waiting; abort comes from
   * a user cancel where snappiness matters.
   */
  ioDrainGraceMs?: number;
  /** Optional cancellation signal. If already aborted, SafeSpawn resolves immediately without spawning. */
  signal?: AbortSignal;
}

export interface SafeSpawnShellOptions extends SafeSpawnOptions {
  /** Optional sandbox to wrap the command through. Required for shell-mode. If omitted, the command runs through `shell ?? /bin/bash -c`. */
  sandbox?: SandboxBackend;
  /** Shell to invoke when no sandbox is provided (also forwarded to sandbox.wrap()). Default `/bin/bash`. */
  shell?: string;
}

export interface SafeSpawnResult {
  /** UTF-8 decoded stdout (truncated to `maxOutputBytes` characters when over). */
  stdout: string;
  /** UTF-8 decoded stderr (truncated to `maxOutputBytes` characters when over). */
  stderr: string;
  /** null when killed by signal without an exit code. */
  exitCode: number | null;
  /** Set when the OS reports the child died from a signal. */
  signal: NodeJS.Signals | null;
  /** True when stdout was capped. */
  stdoutTruncated: boolean;
  /** True when stderr was capped. */
  stderrTruncated: boolean;
  /** True when the timeoutMs fired. */
  timedOut: boolean;
  /** True when ctx.signal aborted us (including pre-spawn). */
  aborted: boolean;
  /** True when the spawn itself failed (file not found, permission). `error` carries the message. */
  spawnFailed: boolean;
  /** Spawn error message when spawnFailed is set. */
  error?: string;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
export const DEFAULT_IO_DRAIN_GRACE_MS = 100;
const TIMEOUT_SIGKILL_GRACE_MS = 2000;

/**
 * Spawn `(file, args)` directly under the unified lifecycle policy. Use this
 * when you know the binary and args (REPL, PowerShell, gitOps). For shell-
 * string spawning under a sandbox, see {@link safeSpawnShell}.
 */
export function safeSpawn(
  file: string,
  args: string[],
  opts: SafeSpawnOptions,
): Promise<SafeSpawnResult> {
  return runLifecycle({
    file,
    args,
    opts,
    cleanup: undefined,
  });
}

/**
 * Spawn a shell `command` string under an optional sandbox. The sandbox
 * backend decides the actual `(file, args)` (e.g. Seatbelt becomes
 * `/usr/bin/sandbox-exec -f profile shell -c command`). The backend's
 * `cleanup` callback is invoked on every exit path — close, error,
 * abort, timeout, pre-spawn-abort. Used by the Bash tool.
 */
export function safeSpawnShell(
  command: string,
  opts: SafeSpawnShellOptions,
): Promise<SafeSpawnResult> {
  const shell = opts.shell ?? "/bin/bash";
  let file: string;
  let args: string[];
  let cleanup: (() => void) | undefined;
  if (opts.sandbox) {
    const wrapped = opts.sandbox.wrap(command, { cwd: opts.cwd, shell });
    file = wrapped.file;
    args = wrapped.args;
    cleanup = wrapped.cleanup;
  } else {
    file = shell;
    args = ["-c", command];
  }
  return runLifecycle({ file, args, opts, cleanup });
}

interface LifecycleArgs {
  file: string;
  args: string[];
  opts: SafeSpawnOptions;
  cleanup: (() => void) | undefined;
}

function runLifecycle({ file, args, opts, cleanup }: LifecycleArgs): Promise<SafeSpawnResult> {
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const abortGrace = opts.ioDrainGraceMs ?? DEFAULT_IO_DRAIN_GRACE_MS;

  // Pre-spawn abort: don't pay spawn cost.
  if (opts.signal?.aborted) {
    safeCleanup(cleanup);
    return Promise.resolve(emptyResult({ aborted: true }));
  }

  return new Promise<SafeSpawnResult>((resolve) => {
    let settled = false;
    const finish = (result: SafeSpawnResult) => {
      if (settled) return;
      settled = true;
      // Always release backend-allocated resources, regardless of exit path.
      // cleanup is best-effort — see seatbelt backend for rationale.
      safeCleanup(cleanup);
      // Remove abort listener so a long-lived AbortSignal (multi-turn
      // session reusing the same controller) doesn't accumulate listeners.
      if (opts.signal && onAbort) {
        opts.signal.removeEventListener("abort", onAbort);
      }
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env: opts.env });
    } catch (err) {
      finish(emptyResult({ spawnFailed: true, error: (err as Error).message }));
      return;
    }

    const stdoutDec = new StringDecoder("utf-8");
    const stderrDec = new StringDecoder("utf-8");
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* may already be dead */ }
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, TIMEOUT_SIGKILL_GRACE_MS).unref();
    }, opts.timeoutMs);

    let onAbort: (() => void) | undefined;
    if (opts.signal) {
      onAbort = () => {
        aborted = true;
        try { child.kill("SIGTERM"); } catch { /* may already be dead */ }
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }, abortGrace).unref();
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) return;
      const piece = stdoutDec.write(chunk);
      if (stdout.length + piece.length > maxBytes) {
        stdoutTruncated = true;
        stdout += piece.slice(0, maxBytes - stdout.length);
      } else {
        stdout += piece;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrTruncated) return;
      const piece = stderrDec.write(chunk);
      if (stderr.length + piece.length > maxBytes) {
        stderrTruncated = true;
        stderr += piece.slice(0, maxBytes - stderr.length);
      } else {
        stderr += piece;
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        aborted,
        spawnFailed: true,
        error: (err as Error).message,
      });
    });

    child.on("close", (code, sig) => {
      clearTimeout(timer);
      // Flush trailing incomplete utf-8 (returns "" when last write completed
      // a sequence). Skip when already truncated — preserves the cap exactly.
      const tailOut = stdoutDec.end();
      const tailErr = stderrDec.end();
      if (tailOut && !stdoutTruncated) {
        if (stdout.length + tailOut.length > maxBytes) {
          stdoutTruncated = true;
          stdout += tailOut.slice(0, maxBytes - stdout.length);
        } else {
          stdout += tailOut;
        }
      }
      if (tailErr && !stderrTruncated) {
        if (stderr.length + tailErr.length > maxBytes) {
          stderrTruncated = true;
          stderr += tailErr.slice(0, maxBytes - stderr.length);
        } else {
          stderr += tailErr;
        }
      }
      finish({
        stdout,
        stderr,
        exitCode: code,
        signal: sig,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        aborted,
        spawnFailed: false,
      });
    });
  });
}

function safeCleanup(cleanup: (() => void) | undefined): void {
  if (!cleanup) return;
  try { cleanup(); } catch { /* best-effort */ }
}

function emptyResult(overrides: Partial<SafeSpawnResult>): SafeSpawnResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    spawnFailed: false,
    ...overrides,
  };
}
