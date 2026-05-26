/**
 * PowerShellTool — execute PowerShell commands (Windows).
 */

import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { spawn } from "node:child_process";

export const powershellToolDef: ToolDefinition = {
  name: "PowerShell",
  description:
    "Execute PowerShell commands. Available on Windows and cross-platform where PowerShell Core is installed.",
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

export async function powershellTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const command = args.command as string;
  const timeout = (args.timeout as number) ?? 120_000;

  if (!command.trim()) {
    return "Error: command is required.";
  }

  // Determine PowerShell executable
  const psCmd = process.platform === "win32" ? "powershell.exe" : "pwsh";
  // A4: child process runs in the Engine's cwd, not the host process cwd.
  const cwd = ctx?.cwd ?? process.cwd();

  // A2: spawn-based so we can honor ctx.signal and not block the event
  // loop. Same kill cascade as Bash.
  if (ctx?.signal?.aborted) {
    return "PowerShell aborted before starting.";
  }

  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (output: string) => {
      if (settled) return;
      settled = true;
      resolve(output);
    };

    // PowerShell's -Command flag takes the script as a single argument;
    // passing it through argv avoids shell quoting issues.
    const child = spawn(
      psCmd,
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { cwd, env: { ...process.env } },
    );

    let stdout = "";
    let stderr = "";
    const MAX = 5 * 1024 * 1024;
    let stdoutOver = false;
    let stderrOver = false;
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, 2000).unref();
    }, timeout);

    const onAbort = () => {
      aborted = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, 2000).unref();
    };
    if (ctx?.signal) {
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutOver) return;
      const piece = chunk.toString("utf-8");
      if (stdout.length + piece.length > MAX) {
        stdoutOver = true;
        stdout += piece.slice(0, MAX - stdout.length);
      } else {
        stdout += piece;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrOver) return;
      const piece = chunk.toString("utf-8");
      if (stderr.length + piece.length > MAX) {
        stderrOver = true;
        stderr += piece.slice(0, MAX - stderr.length);
      } else {
        stderr += piece;
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (ctx?.signal) ctx.signal.removeEventListener("abort", onAbort);
      finish(`PowerShell spawn error: ${(err as Error).message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (ctx?.signal) ctx.signal.removeEventListener("abort", onAbort);

      if (aborted) {
        finish("PowerShell aborted by signal.");
        return;
      }
      if (timedOut) {
        finish(`PowerShell timed out after ${timeout}ms`);
        return;
      }
      if (code !== 0) {
        const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        finish(`PowerShell error:\n${out || `exit code ${code}`}`);
        return;
      }
      finish(stdout.trim() || "(no output)");
    });
  });
}
