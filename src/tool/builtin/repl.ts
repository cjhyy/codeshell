/**
 * REPLTool — execute code in an interactive REPL environment.
 */

import type { ToolDefinition } from "../../types.js";
import { execSync } from "node:child_process";

export const replToolDef: ToolDefinition = {
  name: "REPL",
  description:
    "Execute code in an interactive REPL environment. Supports JavaScript/TypeScript (Node/Bun), " +
    "Python, and Ruby. Results are returned as text output.",
  inputSchema: {
    type: "object",
    properties: {
      language: {
        type: "string",
        enum: ["javascript", "typescript", "python", "ruby"],
        description: "The programming language to execute",
      },
      code: {
        type: "string",
        description: "The code to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000)",
      },
    },
    required: ["language", "code"],
  },
};

export async function replTool(args: Record<string, unknown>): Promise<string> {
  const language = args.language as string;
  const code = args.code as string;
  const timeout = (args.timeout as number) ?? 30_000;

  if (!code.trim()) {
    return "Error: no code provided.";
  }

  const commands: Record<string, { cmd: string; flag: string }> = {
    javascript: { cmd: "node", flag: "-e" },
    typescript: {
      cmd: typeof (globalThis as any).Bun !== "undefined" ? "bun" : "npx tsx",
      flag: "-e",
    },
    python: { cmd: "python3", flag: "-c" },
    ruby: { cmd: "ruby", flag: "-e" },
  };

  const runtime = commands[language];
  if (!runtime) {
    return `Unsupported language: ${language}. Supported: ${Object.keys(commands).join(", ")}`;
  }

  try {
    const result = execSync(`${runtime.cmd} ${runtime.flag} ${JSON.stringify(code)}`, {
      encoding: "utf-8",
      timeout,
      maxBuffer: 1024 * 1024,
      cwd: process.cwd(),
      env: { ...process.env },
    });
    return result.trim() || "(no output)";
  } catch (err: any) {
    const stderr = err.stderr?.toString().trim() ?? "";
    const stdout = err.stdout?.toString().trim() ?? "";
    const output = [stdout, stderr].filter(Boolean).join("\n");
    return `Error executing ${language}:\n${output || err.message}`;
  }
}
