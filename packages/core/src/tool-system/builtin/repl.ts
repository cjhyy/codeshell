/**
 * REPLTool — execute code in an interactive REPL environment.
 */

import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { spawn } from "node:child_process";

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

export async function replTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const language = args.language as string;
  const code = args.code as string;
  const timeout = (args.timeout as number) ?? 30_000;
  // A4: child process runs in the Engine's cwd, not the host process cwd.
  const cwd = ctx?.cwd ?? process.cwd();

  if (!code.trim()) {
    return "Error: no code provided.";
  }

  // A2: each entry is (file, [args]) so we can spawn without a shell.
  // Args are passed as separate arguv entries, eliminating the
  // execSync-style shell-quoting risk.
  const commands: Record<string, { file: string; pre: string[] }> = {
    javascript: { file: "node", pre: ["-e"] },
    typescript: typeof (globalThis as any).Bun !== "undefined"
      ? { file: "bun", pre: ["-e"] }
      : { file: "npx", pre: ["tsx", "-e"] },
    python: { file: "python3", pre: ["-c"] },
    ruby: { file: "ruby", pre: ["-e"] },
  };

  const runtime = commands[language];
  if (!runtime) {
    return `Unsupported language: ${language}. Supported: ${Object.keys(commands).join(", ")}`;
  }

  // A2: REPL is now spawn-based so it can honor ctx.signal and not
  // block the event loop. Mirrors the Bash kill cascade.
  if (ctx?.signal?.aborted) {
    return `${language} aborted before starting.`;
  }

  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (output: string) => {
      if (settled) return;
      settled = true;
      resolve(output);
    };

    const child = spawn(runtime.file, [...runtime.pre, code], {
      cwd,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    const MAX = 1024 * 1024;
    let stdoutOver = false;
    let stderrOver = false;
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* may already be dead */ }
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
      finish(`Failed to spawn ${language}: ${(err as Error).message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (ctx?.signal) ctx.signal.removeEventListener("abort", onAbort);

      if (aborted) {
        finish(`${language} aborted by signal.`);
        return;
      }
      if (timedOut) {
        finish(`${language} timed out after ${timeout}ms`);
        return;
      }
      if (code !== 0) {
        const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        finish(`Error executing ${language}:\n${out || `exit code ${code}`}`);
        return;
      }
      finish(stdout.trim() || "(no output)");
    });
  });
}
