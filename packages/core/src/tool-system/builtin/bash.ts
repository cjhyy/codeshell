/**
 * Built-in Bash shell command execution tool.
 *
 * Spawns commands under an optional OS-level sandbox (Seatbelt on macOS,
 * bubblewrap on Linux). The sandbox is selected by the Engine and handed
 * down via ToolContext.sandbox. Without a sandbox we fall back to the
 * historical behavior — plain shell spawn in the user's environment.
 *
 * The actual lifecycle (spawn, IO drain, byte cap, abort cascade, timeout
 * cascade, listener cleanup) lives in {@link safeSpawnShell}. This file
 * keeps only Bash-specific concerns:
 *
 *   - The env allowlist + deny regex (a Bash threat-model thing — REPL /
 *     PowerShell don't have free-form shell injection from the LLM).
 *   - The final user-facing output formatting (STDERR: prefix, Exit code,
 *     Killed by signal, the truncation message, sandbox denial hints).
 */

import type { ToolContext } from "../context.js";
import { createOffBackend } from "../sandbox/off.js";
import { safeSpawnShell } from "../../runtime/safe-spawn.js";
import { truncateHeadTail } from "../../runtime/truncate-output.js";
import { buildSandboxEnv, mergeShellEnv, defaultShellBinary } from "../../runtime/spawn-common.js";
import { backgroundShellManager } from "../../runtime/background-shell.js";
import type { ToolDefinition, ToolResult } from "../../types.js";
import type { SandboxBackend } from "../sandbox/index.js";
import type { ToolExecutionResult, ToolFailure } from "./index.js";
import { createNativeModelTraceCollector } from "../../model-traces/context.js";

/** UI 标记:这次 Bash 走没走沙箱 + 网络策略。off 也带(显式标「未隔离」)。 */
function sandboxMark(backend: SandboxBackend): NonNullable<ToolResult["sandbox"]> {
  return backend.name === "off"
    ? { backend: "off" }
    : { backend: backend.name, network: backend.network };
}

export const bashToolDef: ToolDefinition = {
  name: "Bash",
  description:
    "Execute a shell command and return its output. " +
    "Use for ordinary shell commands, system operations, version-control commands, " +
    "package-manager commands, running tests, installing packages, etc. Prefer Bash " +
    "over PowerShell unless the task needs PowerShell-specific syntax or APIs. " +
    "A nonzero exit is a command status, not necessarily a tool malfunction. Query commands " +
    "can use exit 1 for no matches; handle documented expected statuses with an explicit " +
    "conditional and preserve unexpected failures instead of adding blanket `|| true`. " +
    "Use separate calls for independent checks. In an `&&` chain, a nonzero status stops " +
    "later commands, but earlier side effects remain; inspect state before retrying mutations.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 120000). Outer registry caps at 1h.",
      },
      description: {
        type: "string",
        description: "Short description of what the command does",
      },
      run_in_background: {
        type: "boolean",
        description:
          "Run the command in the background instead of blocking. Use for BOTH long-lived services " +
          "(a dev server like `npm run dev`) AND slow one-shot tasks that would otherwise block for a " +
          "long time (a download, a long build/test run). Returns immediately with a shell_id. " +
          "Explicitly set background_behavior for EVERY background launch: continue for a service " +
          "or when you have other work to do; wait_for_exit only when the next step requires a finite " +
          "command to finish. When the command FINISHES you are automatically notified and woken to " +
          "continue — do NOT sleep, poll, or repeatedly BashOutput to wait for completion. A service " +
          "that stays running never produces that exit notification; check its readiness separately. " +
          "Use BashOutput(shell_id) to inspect startup logs on demand, KillShell(shell_id) to stop one " +
          "before restarting it, ListShells() to enumerate. " +
          "Prefer KillShell over raw kill/pkill for managed background tasks so intentional stops " +
          "are tracked correctly and their whole process group is terminated. The process is " +
          "killed when the session/app exits.",
      },
      background_behavior: {
        type: "string",
        enum: ["continue", "wait_for_exit"],
        description:
          "With run_in_background=true, explicitly choose this for every new launch. continue: " +
          "keep the current turn running after launch so you can inspect service readiness, use its " +
          "UI, or do independent work; it does not automatically pause the turn. wait_for_exit: " +
          "pause this turn until the finite command exits and its completion notification wakes " +
          "you. Never use wait_for_exit for a dev server, watcher, tunnel, or GUI that stays open. " +
          "Omitting this retains wait_for_exit for compatibility with existing callers.",
      },
    },
    required: ["command"],
  },
};

const MAX_OUTPUT = 100_000;
const MAX_BUFFER = 10 * 1024 * 1024;
// Feature evidence from this running Host, rather than another installed CLI's
// version. Protocol 1 shares workspace publication locks with package runtimes.
const workspaceWriteShellEnv = { CODESHELL_WORKSPACE_WRITE_PROTOCOL: "1" };

// The env allowlist / deny regex that hardens a sandboxed shell now lives in
// runtime/spawn-common.ts so foreground (this tool) and background shells
// share one source of truth. The `off` backend keeps the historical
// full-passthrough behavior — the user explicitly opted out of sandboxing.

export async function bashTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string | ToolExecutionResult> {
  const command = args.command as string;
  if (!command) return "Error: command is required";

  // A non-positive timeout (caller passing 0 / -5 / NaN) falls back to the
  // default. `|| 120_000` only caught 0/NaN; a negative slipped through to
  // setTimeout (clamped to 0 → near-instant kill → confusing "timed out after
  // -5ms"). Treat non-positive as "use default" so the command actually runs.
  const rawTimeout = args.timeout as number;
  const timeout = typeof rawTimeout === "number" && rawTimeout > 0 ? rawTimeout : 120_000;
  const cwd = ctx?.cwd ?? process.cwd();
  const shell = defaultShellBinary();
  const backend = ctx?.sandbox ?? createOffBackend();
  const sandbox = sandboxMark(backend);
  // Tag every textual return below with the sandbox mark so the UI badge
  // shows up whether the command succeeded, failed, timed out, or aborted.
  const mark = (result: string): ToolExecutionResult => ({ ok: true, result, sandbox });
  const fail = (
    error: string,
    details: Pick<ToolFailure, "exitCode" | "signal" | "stderr"> = {},
  ): ToolExecutionResult => ({ ok: false, error, sandbox, ...details });
  if (
    args.background_behavior !== undefined &&
    args.background_behavior !== "continue" &&
    args.background_behavior !== "wait_for_exit"
  ) {
    return fail("background_behavior must be 'continue' or 'wait_for_exit'.");
  }
  // Project localEnvironment.env (ctx.shellEnv) layers on top of either the
  // full passthrough (off) or the hardened allowlist (sandboxed) — see
  // mergeShellEnv. Background mode merges the same way inside the manager.
  const baseEnv = backend.name === "off" ? { ...process.env } : buildSandboxEnv();
  const env: NodeJS.ProcessEnv = {
    ...mergeShellEnv(baseEnv, ctx?.shellEnv),
    ...workspaceWriteShellEnv,
  };

  // Process lifetime and turn continuation are separate: a service must leave
  // the model free to check readiness and use it while it is still running.
  // Preserve the historical exit-wait boundary for callers that omit the mode.
  if (args.run_in_background === true) {
    const backgroundBehavior = args.background_behavior ?? "wait_for_exit";
    // Only an explicit declaration marks finite work a Goal may wait on; the
    // legacy omitted default is too often a dev server to park on its exit.
    const backgroundResult = runInBackground(
      command,
      ctx,
      args.background_behavior === "wait_for_exit",
    );
    if (backgroundResult.startsWith("Error:")) return fail(backgroundResult);
    if (backgroundBehavior === "wait_for_exit") {
      ctx?.runYield?.request("background_notification");
    }
    return mark(`${backgroundResult}\nbackground_behavior: ${backgroundBehavior}`);
  }

  // A6: lifecycle (spawn, kill cascade, IO drain, byte cap, abort/timeout)
  // is centralized in safeSpawnShell. We still handle Bash's user-facing
  // output formatting here.
  // Capture pre-spawn abort state so we can produce the historical
  // "aborted before starting" message; SafeSpawn collapses both pre- and
  // mid-flight abort to aborted=true.
  const wasAbortedBeforeStart = ctx?.signal?.aborted === true;
  const diagnosticPipe = createNativeModelTraceCollector({
    workspacePath: cwd,
    sessionId: ctx?.sessionId,
  });
  delete env.CODESHELL_MODEL_TRACE_FD;
  if (diagnosticPipe) env.CODESHELL_MODEL_TRACE_FD = "3";
  const result = await safeSpawnShell(command, {
    cwd,
    env,
    timeoutMs: timeout,
    maxOutputBytes: MAX_BUFFER,
    sandbox: backend,
    shell,
    signal: ctx?.signal,
    diagnosticPipe,
  });

  if (result.aborted) {
    return fail(
      wasAbortedBeforeStart ? "Bash aborted before starting." : "Bash aborted by signal.",
    );
  }
  if (result.timedOut) {
    return fail(`Command timed out after ${timeout}ms`);
  }
  if (result.spawnFailed) {
    return fail(`Failed to spawn command: ${result.error ?? "unknown error"}`);
  }

  let body = "";
  if (result.stdout) body += result.stdout;
  if (result.stderr) body += (body ? "\n" : "") + `STDERR:\n${result.stderr}`;
  if (!body) body = "(command produced no output)";

  // Truncate the OUTPUT body head+tail (TODO 2.11) — the tail of a failing
  // command (the error / final summary) is usually the most useful part, so we
  // keep both ends instead of dropping the end. The exit-code/signal status
  // line is prepended AFTER truncation so it's never lost.
  if (body.length > MAX_OUTPUT) {
    body = truncateHeadTail(body, { cap: MAX_OUTPUT });
  }

  const code = result.exitCode;
  const sig = result.signal;
  let output = body;
  if (code !== 0 && code !== null) {
    // Semantic non-zero-exit marker (TODO 2.11): clear "command FAILED" line.
    output = `Exit code: ${code} (command failed)\n${output}`;
  } else if (code === null && sig) {
    // Killed by a signal we didn't time out on — OOM-kill, sandbox-kill,
    // external SIGKILL. Surface so the model can distinguish from our
    // own timeout path above.
    output = `Killed by signal: ${sig}\n${output}`;
  }

  const hint = backend.hintForBlockedOutput?.(result.stderr);
  if (hint) output += hint;

  if (code === 1 && !result.stderr && !hint) {
    output +=
      '\nHint: No stderr was produced. Exit code 1 can mean "no matches" for a query or ' +
      "condition, or a command error. Check the command's documented exit-status meaning; " +
      "handle only expected statuses and preserve other failures.";
  }

  if ((code !== 0 && code !== null) || (code === null && sig)) {
    return fail(output, { exitCode: code, signal: sig, stderr: result.stderr });
  }
  return mark(output);
}

/**
 * Bash(run_in_background=true) branch: start a long-lived background shell
 * through the BackgroundShellManager and return its handle. Same sandbox as
 * the foreground path (D8). Rejected in unattended automation runs (§5.5)
 * because no one is there to reap a dev server.
 */
function runInBackground(command: string, ctx?: ToolContext, waitForExit = false): string {
  if (ctx?.allowBackgroundShells === false) {
    return "Error: background shells are not available in automation/headless runs. Run the command in the foreground, or have a human start the dev server.";
  }
  const sessionId = ctx?.sessionId;
  if (!sessionId) {
    return "Error: run_in_background requires a session context (no sessionId available).";
  }
  const mgr = ctx?.backgroundShells ?? backgroundShellManager;
  const diagnosticPipe = createNativeModelTraceCollector({ workspacePath: ctx?.cwd, sessionId });
  const r = mgr.spawnBackground({
    command,
    cwd: ctx?.cwd ?? process.cwd(),
    sessionId,
    sandbox: ctx?.sandbox,
    shellEnv: {
      ...ctx?.shellEnv,
      ...workspaceWriteShellEnv,
      CODESHELL_MODEL_TRACE_FD: diagnosticPipe ? "3" : "",
    },
    diagnosticPipe,
    waitForExit,
  });
  if (!r.ok) {
    return `Error: ${r.error}`;
  }
  return [
    "Started background shell.",
    `shell_id: ${r.shellId}`,
    `command: ${command}`,
    `(Use BashOutput("${r.shellId}") to read output; KillShell("${r.shellId}") to stop; ListShells() to enumerate.)`,
  ].join("\n");
}
