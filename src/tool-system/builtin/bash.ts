/**
 * Built-in Bash shell command execution tool.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "../../types.js";

const execAsync = promisify(exec);

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

export async function bashTool(args: Record<string, unknown>): Promise<string> {
  const command = args.command as string;
  if (!command) return "Error: command is required";

  const timeout = (args.timeout as number) || 120_000;

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      cwd: process.cwd(),
      env: { ...process.env },
      shell: process.env.SHELL || "/bin/bash",
    });

    let output = "";
    if (stdout) output += stdout;
    if (stderr) output += (output ? "\n" : "") + `STDERR:\n${stderr}`;
    if (!output) output = "(command completed with no output)";

    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + `\n\n... output truncated (${output.length} chars total)`;
    }

    return output;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };

    if (execErr.killed) {
      return `Command timed out after ${timeout}ms`;
    }

    let output = "";
    if (execErr.stdout) output += execErr.stdout;
    if (execErr.stderr) output += (output ? "\n" : "") + `STDERR:\n${execErr.stderr}`;
    if (!output) output = execErr.message ?? "Command failed with no output";

    if (execErr.code !== undefined) {
      output = `Exit code: ${execErr.code}\n${output}`;
    }

    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + "\n... output truncated";
    }

    return output;
  }
}
