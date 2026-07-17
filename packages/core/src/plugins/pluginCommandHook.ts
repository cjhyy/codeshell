/**
 * pluginCommandHook — execute a plugin's command-type hook as a child
 * process and translate its stdout into a HookResult.
 *
 * This is the plugin-side analogue of `src/hooks/shell-runner.ts`. The two
 * runners are intentionally separate because they speak different protocols:
 *
 *   src/hooks/shell-runner.ts     codeshell-native: stdout is a HookResult
 *                                 JSON envelope ({ messages, decision, ... }).
 *                                 Used by user-authored settings.hooks.
 *
 *   this file                     CC plugin protocol: stdout is one of
 *                                 - { hookSpecificOutput: { hookEventName, additionalContext } }
 *                                 - { additional_context: "..." }            (Cursor)
 *                                 - { additionalContext: "..." }             (SDK)
 *                                 We normalize all three into HookResult.messages
 *                                 so downstream hook plumbing (inject.ts) is
 *                                 untouched.
 *
 * env contract:
 *   CODESHELL_PLUGIN_ROOT   — set to installPath. Plugin command strings
 *                             reference this via ${CODESHELL_PLUGIN_ROOT}
 *                             (varRewrite.ts rewrites CC's CLAUDE_PLUGIN_ROOT
 *                             to this name at install time).
 *   PLUGIN_ROOT             — Codex-compatible alias for the installed root.
 *   CODESHELL_PLUGIN_DATA   — stable writable state directory for this plugin.
 *   PLUGIN_DATA             — Codex-compatible alias for the state directory.
 *   CODESHELL_HOOK_EVENT    — the codeshell-side event name (snake_case)
 *
 * We deliberately do NOT set CLAUDE_PLUGIN_ROOT here. Plugin scripts that
 * branch on which host they detect (e.g. superpowers' session-start checks
 * `[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]`) get rewritten by varRewrite.ts at
 * install time, so the branch they take after rewrite is the codeshell
 * branch — not the CC one.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HookContext, HookResult } from "../hooks/events.js";
import { MAX_HOOK_OUTPUT_BYTES } from "../hooks/hook-output.js";
import { closeHookStdin, MAX_HOOK_STDIN_BYTES, writeHookStdin } from "../hooks/shell-runner.js";
import { killChildTree } from "../runtime/spawn-common.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export interface PluginCommandHookSpec {
  /** Shell command line, with ${CODESHELL_PLUGIN_ROOT} placeholder allowed. */
  command: string;
  /** Plugin install path; exported as CODESHELL_PLUGIN_ROOT for the child. */
  installPath: string;
  /** Plugin install key (`name@marketplace`), used for log lines. */
  pluginKey: string;
  /** Stable writable plugin data directory; primarily an injection point for tests/hosts. */
  dataPath?: string;
  /** Per-hook override; falls back to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

function codeShellHome(): string {
  return process.env.CODE_SHELL_HOME || join(process.env.HOME ?? homedir(), ".code-shell");
}

export function resolvePluginDataPath(pluginKey: string): string {
  const stableKey = createHash("sha256").update(pluginKey).digest("hex");
  return join(codeShellHome(), "plugin-data", stableKey);
}

/**
 * Extract the user-facing context string from a CC plugin's stdout JSON.
 * Returns null if the payload doesn't carry context (which is valid — the
 * hook may be doing side effects only).
 */
function extractAdditionalContext(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // Claude Code nested shape: { hookSpecificOutput: { additionalContext } }
  const hso = obj.hookSpecificOutput;
  if (hso && typeof hso === "object") {
    const ctx = (hso as Record<string, unknown>).additionalContext;
    if (typeof ctx === "string" && ctx.length > 0) return ctx;
  }

  // Cursor snake_case (top-level)
  if (typeof obj.additional_context === "string" && obj.additional_context.length > 0) {
    return obj.additional_context;
  }

  // SDK standard (top-level)
  if (typeof obj.additionalContext === "string" && obj.additionalContext.length > 0) {
    return obj.additionalContext;
  }

  return null;
}

function extractExplicitDenial(parsed: unknown): { message?: string } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const nested =
    obj.hookSpecificOutput && typeof obj.hookSpecificOutput === "object"
      ? (obj.hookSpecificOutput as Record<string, unknown>)
      : undefined;
  const decision =
    obj.decision ?? obj.permissionDecision ?? nested?.decision ?? nested?.permissionDecision;
  if (decision !== "deny" && decision !== "reject") return null;
  const message =
    obj.reason ??
    obj.message ??
    obj.permissionDecisionReason ??
    nested?.reason ??
    nested?.message ??
    nested?.permissionDecisionReason;
  return typeof message === "string" && message.trim() ? { message: message.trim() } : {};
}

function parseJson(stdout: string): unknown | undefined {
  if (!stdout) return undefined;
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Run one plugin hook command. CC's exit-code 2 and explicit deny/reject JSON
 * are normalized to the native HookResult deny contract. Other failures stay
 * non-blocking so a broken plugin does not wedge the engine.
 *
 * Stdin carries the same envelope shape the codeshell-native shell-runner
 * uses (eventName + data) so plugin authors who want richer context can
 * read it; CC plugins typically ignore stdin and emit context derived from
 * their own state (e.g. reading a SKILL.md off disk via PLUGIN_ROOT).
 */
export async function runPluginCommandHook(
  spec: PluginCommandHookSpec,
  ctx: HookContext,
  abortSignal?: AbortSignal,
): Promise<HookResult> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = abortSignal ?? (ctx.data.signal as AbortSignal | undefined);
  if (signal?.aborted) return {};

  return new Promise<HookResult>((resolve) => {
    let child;
    try {
      const pluginDataPath = spec.dataPath ?? resolvePluginDataPath(spec.pluginKey);
      mkdirSync(pluginDataPath, { recursive: true, mode: 0o700 });

      // Strip Claude-specific plugin vars from the inherited env: a plugin
      // script that branches on `[ -n "$CLAUDE_PLUGIN_ROOT" ]` must conclude
      // "not Claude Code" and pick the codeshell branch. varRewrite.ts
      // converted literal root/data references to CodeShell-native names;
      // this drop closes the runtime side of the same story.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const {
        CLAUDE_PLUGIN_ROOT: _strippedRoot,
        CLAUDE_PLUGIN_DATA: _strippedData,
        ...parentEnv
      } = process.env;
      child = spawn(spec.command, [], {
        shell: true,
        env: {
          ...parentEnv,
          CODESHELL_PLUGIN_ROOT: spec.installPath,
          PLUGIN_ROOT: spec.installPath,
          CODESHELL_PLUGIN_DATA: pluginDataPath,
          PLUGIN_DATA: pluginDataPath,
          CODESHELL_HOOK_EVENT: ctx.eventName,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[plugin-hook] spawn failed for ${spec.pluginKey} command "${spec.command}":`,
        (err as Error).message,
      );
      resolve({});
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    // Output byte caps mirror src/hooks/shell-runner.ts so a chatty plugin
    // hook can't hold engine memory hostage. Past the cap we SIGTERM the
    // child and treat the hook as failed; stderr cap truncates with a
    // marker instead of failing the hook.
    let stdoutBytes = 0;
    let stdoutCapped = false;
    let stderrCapped = false;
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

    const timer = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn(
        `[plugin-hook] ${spec.pluginKey} ${ctx.eventName} timed out after ${timeoutMs}ms`,
      );
      // win32: taskkill /T reaps the tree; POSIX: SIGTERM → grace → SIGKILL.
      killChildTree(child, 1000);
      settle({});
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_HOOK_OUTPUT_BYTES) {
        if (!stdoutCapped) {
          stdoutCapped = true;
          // eslint-disable-next-line no-console
          console.warn(
            `[plugin-hook] ${spec.pluginKey} ${ctx.eventName} stdout exceeded ${MAX_HOOK_OUTPUT_BYTES} bytes — killing`,
          );
          killChildTree(child, 1000);
        }
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > MAX_HOOK_OUTPUT_BYTES) {
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
      console.error(`[plugin-hook] ${spec.pluginKey} ${ctx.eventName} spawn error:`, err.message);
      settle({});
    });

    let stdinFinished = false;
    let pendingClose: { code: number | null } | undefined;
    const handleClose = (code: number | null) => {
      if (stdoutCapped) {
        // eslint-disable-next-line no-console
        console.error(
          `[plugin-hook] ${spec.pluginKey} ${ctx.eventName} killed due to oversized stdout (> ${MAX_HOOK_OUTPUT_BYTES} bytes)`,
        );
        settle({});
        return;
      }
      const trimmed = stdout.trim();
      const parsedForDecision = parseJson(trimmed);
      const explicitDenial = extractExplicitDenial(parsedForDecision);
      if (code === 2 || explicitDenial) {
        const message =
          stderr.trim() || explicitDenial?.message || "Plugin denied this tool operation";
        settle({ decision: "deny", messages: [message] });
        return;
      }
      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[plugin-hook] ${spec.pluginKey} ${ctx.eventName} exited ${code}; stderr:`,
          stderr.slice(0, 500),
        );
        settle({});
        return;
      }
      if (trimmed.length === 0) {
        settle({});
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[plugin-hook] ${spec.pluginKey} ${ctx.eventName} returned non-JSON stdout, ignoring:`,
          (err as Error).message,
          "\nfirst 200 chars:",
          trimmed.slice(0, 200),
        );
        settle({});
        return;
      }
      const additional = extractAdditionalContext(parsed);
      if (additional === null) {
        settle({});
        return;
      }
      settle({ messages: [additional] });
    };
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (settled) return;
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

    // Stdin envelope: matches the shape codeshell-native shell hooks use.
    let envelope: string;
    try {
      envelope = JSON.stringify({ eventName: ctx.eventName, data: ctx.data });
    } catch {
      closeHookStdin(child.stdin);
      finishStdin();
      return;
    }
    if (Buffer.byteLength(envelope, "utf8") > MAX_HOOK_STDIN_BYTES) {
      // eslint-disable-next-line no-console
      console.warn(
        `[plugin-hook] ${spec.pluginKey} ${ctx.eventName} stdin exceeded ${MAX_HOOK_STDIN_BYTES} bytes; running without envelope`,
      );
      closeHookStdin(child.stdin);
      finishStdin();
      return;
    }

    setImmediate(() => {
      void (async () => {
        if (settled) return;
        try {
          await writeHookStdin(child.stdin, envelope);
          finishStdin();
        } catch (error) {
          clearTimeout(timer);
          const err = error as NodeJS.ErrnoException;
          const failure = {
            type: "stdin_error" as const,
            code: typeof err?.code === "string" ? err.code : "UNKNOWN",
            message: err instanceof Error ? err.message : String(error),
          };
          // eslint-disable-next-line no-console
          console.error(
            `[plugin-hook] ${spec.pluginKey} ${ctx.eventName} stdin error:`,
            failure.message,
          );
          killChildTree(child, 1000);
          settle({ data: { hookFailure: failure } });
        }
      })();
    });
  });
}
