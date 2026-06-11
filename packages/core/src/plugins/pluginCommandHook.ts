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
 *   CODESHELL_HOOK_EVENT    — the codeshell-side event name (snake_case)
 *
 * We deliberately do NOT set CLAUDE_PLUGIN_ROOT here. Plugin scripts that
 * branch on which host they detect (e.g. superpowers' session-start checks
 * `[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]`) get rewritten by varRewrite.ts at
 * install time, so the branch they take after rewrite is the codeshell
 * branch — not the CC one.
 */

import { spawn } from "node:child_process";
import type { HookContext, HookResult } from "../hooks/events.js";
import { MAX_HOOK_OUTPUT_BYTES } from "../hooks/hook-output.js";
import { killChildTree } from "../runtime/spawn-common.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export interface PluginCommandHookSpec {
  /** Shell command line, with ${CODESHELL_PLUGIN_ROOT} placeholder allowed. */
  command: string;
  /** Plugin install path; exported as CODESHELL_PLUGIN_ROOT for the child. */
  installPath: string;
  /** Plugin install key (`name@marketplace`), used for log lines. */
  pluginKey: string;
  /** Per-hook override; falls back to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
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

/**
 * Run one plugin hook command. Returns an empty HookResult on any failure
 * (spawn error, timeout, non-zero exit, unparseable stdout) so the hook
 * chain keeps moving — a misbehaving plugin must not wedge the engine.
 *
 * Stdin carries the same envelope shape the codeshell-native shell-runner
 * uses (eventName + data) so plugin authors who want richer context can
 * read it; CC plugins typically ignore stdin and emit context derived from
 * their own state (e.g. reading a SKILL.md off disk via PLUGIN_ROOT).
 */
export async function runPluginCommandHook(
  spec: PluginCommandHookSpec,
  ctx: HookContext,
): Promise<HookResult> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<HookResult>((resolve) => {
    let child;
    try {
      // Strip CLAUDE_PLUGIN_ROOT from the inherited env: a plugin script
      // that branches on `[ -n "$CLAUDE_PLUGIN_ROOT" ]` must conclude
      // "not Claude Code" and pick the codeshell branch. varRewrite.ts
      // converted the literal `${CLAUDE_PLUGIN_ROOT}` references to the
      // codeshell name; this drop closes the runtime side of the same
      // story.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { CLAUDE_PLUGIN_ROOT: _stripped, ...parentEnv } = process.env;
      child = spawn(spec.command, [], {
        shell: true,
        env: {
          ...parentEnv,
          CODESHELL_PLUGIN_ROOT: spec.installPath,
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
      resolve(value);
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
      console.error(
        `[plugin-hook] ${spec.pluginKey} ${ctx.eventName} spawn error:`,
        err.message,
      );
      settle({});
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (stdoutCapped) {
        // eslint-disable-next-line no-console
        console.error(
          `[plugin-hook] ${spec.pluginKey} ${ctx.eventName} killed due to oversized stdout (> ${MAX_HOOK_OUTPUT_BYTES} bytes)`,
        );
        settle({});
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
      const trimmed = stdout.trim();
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
    });

    // Stdin envelope: matches the shape codeshell-native shell hooks use.
    // CC plugins generally don't read stdin, but writing it is cheap and
    // keeps the protocol open for plugin authors who want it.
    try {
      child.stdin?.write(JSON.stringify({ eventName: ctx.eventName, data: ctx.data }));
      child.stdin?.end();
    } catch {
      // Child may have closed stdin already; not fatal.
    }
  });
}
