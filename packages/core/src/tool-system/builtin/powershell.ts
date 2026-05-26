/**
 * PowerShellTool — execute PowerShell commands (Windows).
 */

import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { execSync } from "node:child_process";

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

  try {
    const result = execSync(
      `${psCmd} -NoProfile -NonInteractive -Command ${JSON.stringify(command)}`,
      {
        encoding: "utf-8",
        timeout,
        maxBuffer: 5 * 1024 * 1024,
        cwd,
      },
    );
    return result.trim() || "(no output)";
  } catch (err: any) {
    const stderr = err.stderr?.toString().trim() ?? "";
    const stdout = err.stdout?.toString().trim() ?? "";
    const output = [stdout, stderr].filter(Boolean).join("\n");
    return `PowerShell error:\n${output || err.message}`;
  }
}
