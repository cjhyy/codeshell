/**
 * REPLTool — execute code in an interactive REPL environment.
 *
 * The lifecycle (spawn, abort/timeout cascade, IO drain, byte cap) is
 * centralized in {@link safeSpawn}; this file only carries the language
 * runtime selection table and the REPL-specific output formatting.
 */

import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { safeSpawn } from "../../runtime/safe-spawn.js";
import { buildSandboxEnv, mergeShellEnv } from "../../runtime/spawn-common.js";

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

const REPL_MAX_BUFFER = 1024 * 1024;

export async function replTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const language = args.language as string;
  const code = args.code as string;
  // `??` only catches null/undefined — a non-positive timeout (0/-5) would slip
  // through to setTimeout (clamped to 0 → near-instant kill). Floor to default.
  const rawTimeout = args.timeout as number;
  const timeout = typeof rawTimeout === "number" && rawTimeout > 0 ? rawTimeout : 30_000;
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
    // Bun workers reuse their own binary even if a project overrides PATH.
    // Node hosts use their installed Bun from PATH; never download a runtime
    // through npx or load the project's .env implicitly.
    typescript: {
      file: typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? process.execPath : "bun",
      pre: ["--no-env-file", "-e"],
    },
    python: { file: "python3", pre: ["-c"] },
    ruby: { file: "ruby", pre: ["-e"] },
  };

  const runtime = commands[language];
  if (!runtime) {
    return `Unsupported language: ${language}. Supported: ${Object.keys(commands).join(", ")}`;
  }

  const wasAbortedBeforeStart = ctx?.signal?.aborted === true;
  const result = await safeSpawn(runtime.file, [...runtime.pre, code], {
    cwd,
    // Same allowlist as a sandboxed Bash: host secrets stay out, the user's
    // explicit project env (localEnvironment.env) is layered on top.
    env: mergeShellEnv(buildSandboxEnv(), {
      ...ctx?.shellEnv,
      CODESHELL_WORKSPACE_WRITE_PROTOCOL: "1",
    }),
    timeoutMs: timeout,
    maxOutputBytes: REPL_MAX_BUFFER,
    signal: ctx?.signal,
  });

  if (result.aborted) {
    return wasAbortedBeforeStart
      ? `${language} aborted before starting.`
      : `${language} aborted by signal.`;
  }
  if (result.timedOut) {
    return `${language} timed out after ${timeout}ms`;
  }
  if (result.spawnFailed) {
    const requirement = language === "typescript" ? " (Bun must be installed and available)" : "";
    return `Failed to spawn ${language}${requirement}: ${result.error ?? "unknown error"}`;
  }
  if (result.exitCode !== 0) {
    const out = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    return `Error executing ${language}:\n${out || `exit code ${result.exitCode}`}`;
  }
  return result.stdout.trim() || "(no output)";
}
