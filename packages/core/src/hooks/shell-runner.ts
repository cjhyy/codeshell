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
import type { HookContext, HookResult } from "./events.js";
import type { SettingsHookConfig } from "../types.js";
import { MAX_HOOK_OUTPUT_BYTES, validateHookResult } from "./hook-output.js";
import { killChildTree } from "../runtime/spawn-common.js";

// Re-export so existing call sites that import { validateHookResult } from
// "./shell-runner.js" (e.g. tests) keep compiling.
export { validateHookResult };

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run one shell-hook command and return the parsed HookResult. Catches
 * every failure mode (spawn error, timeout, malformed JSON) and
 * returns an empty result so the registry's chain keeps going.
 */
export async function runShellHook(
  config: SettingsHookConfig,
  ctx: HookContext,
): Promise<HookResult> {
  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  return new Promise<HookResult>((resolve) => {
    let child;
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

    const settle = (value: HookResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn(
        `[hooks] ${config.event} hook timed out after ${timeoutMs}ms: ${config.command}`,
      );
      // win32: taskkill /T reaps the shell tree; POSIX: SIGTERM → grace →
      // SIGKILL (a graceful handler gets a moment to flush). See killChildTree.
      killChildTree(child, 1000);
      settle({});
    }, timeoutMs);

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
      console.error(
        `[hooks] ${config.event} hook failed: ${config.command}`,
        err.message,
      );
      settle({});
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
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
      console.error(
        `[hooks] ${config.event} hook exited with code ${code}:`,
        stderr.slice(0, 500),
      );
      settle({});
    });

    // Write the context envelope on stdin then close.
    try {
      child.stdin?.write(JSON.stringify({ eventName: ctx.eventName, data: ctx.data }));
      child.stdin?.end();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[hooks] failed to write stdin for ${config.event}:`,
        (err as Error).message,
      );
      settle({});
    }
  });
}

/**
 * Check whether the hook should fire for the current ctx, respecting
 * the optional `matcher` regex. Returns false for non-tool events
 * when matcher is set (matcher only makes sense when ctx.data has a
 * toolName field).
 */
export function shellHookMatches(
  config: SettingsHookConfig,
  ctx: HookContext,
): boolean {
  if (!config.matcher) return true;
  const toolName = ctx.data.toolName;
  if (typeof toolName !== "string") return false;
  try {
    return new RegExp(config.matcher).test(toolName);
  } catch {
    // Bad regex in user config — log once, treat as non-matching.
    // eslint-disable-next-line no-console
    console.warn(
      `[hooks] invalid matcher "${config.matcher}" for ${config.event}; skipping`,
    );
    return false;
  }
}
