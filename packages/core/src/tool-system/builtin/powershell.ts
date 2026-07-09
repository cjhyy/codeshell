/**
 * PowerShellTool — execute PowerShell commands (Windows or pwsh).
 *
 * The lifecycle (spawn, abort/timeout cascade, IO drain, byte cap) is
 * centralized in {@link safeSpawn}; this file only carries the pwsh /
 * powershell.exe selection + the PowerShell-specific output formatting.
 */

import type { ToolDefinition, ToolResult } from "../../types.js";
import type { ToolContext } from "../context.js";
import { safeSpawn } from "../../runtime/safe-spawn.js";

export const powershellToolDef: ToolDefinition = {
  name: "PowerShell",
  description:
    "Execute PowerShell commands. Use only when the user explicitly asks for PowerShell " +
    "or the task requires PowerShell-specific cmdlets, Windows APIs, registry access, " +
    "or .ps1 behavior. Do NOT use for ordinary file, git, package-manager, test, " +
    "or POSIX-style shell commands; use Bash for those.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The PowerShell command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 120000)",
      },
    },
    required: ["command"],
  },
};

const PS_MAX_BUFFER = 5 * 1024 * 1024;
const POWERSHELL_SANDBOX_MARK = { backend: "off" } satisfies NonNullable<ToolResult["sandbox"]>;

function markPowerShellResult(result: string): { result: string; sandbox: ToolResult["sandbox"] } {
  return { result, sandbox: POWERSHELL_SANDBOX_MARK };
}

export async function powershellTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string | { result: string; sandbox: ToolResult["sandbox"] }> {
  const command = args.command as string;
  // `??` only catches null/undefined — a non-positive timeout (0/-5) would slip
  // through to setTimeout (clamped to 0 → near-instant kill). Floor to default.
  const rawTimeout = args.timeout as number;
  const timeout = typeof rawTimeout === "number" && rawTimeout > 0 ? rawTimeout : 120_000;

  if (!command.trim()) {
    return markPowerShellResult("Error: command is required.");
  }

  // Determine PowerShell executable.
  const psCmd = process.platform === "win32" ? "powershell.exe" : "pwsh";
  // A4: child process runs in the Engine's cwd, not the host process cwd.
  const cwd = ctx?.cwd ?? process.cwd();

  const wasAbortedBeforeStart = ctx?.signal?.aborted === true;
  // PowerShell's -Command flag takes the script as a single argument;
  // passing it through argv avoids shell quoting issues.
  const result = await safeSpawn(psCmd, ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd,
    env: { ...process.env },
    timeoutMs: timeout,
    maxOutputBytes: PS_MAX_BUFFER,
    signal: ctx?.signal,
  });

  if (result.aborted) {
    return markPowerShellResult(
      wasAbortedBeforeStart
        ? "PowerShell aborted before starting."
        : "PowerShell aborted by signal.",
    );
  }
  if (result.timedOut) {
    return markPowerShellResult(`PowerShell timed out after ${timeout}ms`);
  }
  if (result.spawnFailed) {
    return markPowerShellResult(`PowerShell spawn error: ${result.error ?? "unknown error"}`);
  }
  if (result.exitCode !== 0) {
    const out = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    return markPowerShellResult(`PowerShell error:\n${out || `exit code ${result.exitCode}`}`);
  }
  return markPowerShellResult(result.stdout.trim() || "(no output)");
}
