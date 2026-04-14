/**
 * SDK convenience factory — create a RunManager with sensible defaults.
 *
 * Usage from an external repo:
 * ```ts
 * import { createRunManager } from "code-shell";
 *
 * const manager = createRunManager({
 *   llm: {
 *     provider: "openai",
 *     model: "anthropic/claude-sonnet-4",
 *     apiKey: process.env.OPENROUTER_API_KEY,
 *     baseUrl: "https://openrouter.ai/api/v1",
 *   },
 * });
 *
 * const run = await manager.submit({ objective: "Refactor the auth module" });
 * ```
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { LLMConfig, PermissionMode } from "../types.js";
import type { EngineConfig } from "../engine/engine.js";
import type { Evaluator } from "./Evaluator.js";
import { RunManager } from "./RunManager.js";
import { FileRunStore } from "./FileRunStore.js";

export interface CreateRunManagerOptions {
  /** LLM configuration (required). */
  llm: LLMConfig;

  /** Working directory. Default: process.cwd() */
  cwd?: string;

  /** Max turns per engine execution. Default: 30 */
  maxTurns?: number;

  /** Max context tokens. Default: 200_000 */
  maxContextTokens?: number;

  /** Permission mode. Default: "acceptEdits" */
  permissionMode?: PermissionMode;

  /** Queue concurrency. Default: 1 */
  concurrency?: number;

  /** Custom storage directory for runs. Default: ~/.code-shell/runs */
  runsDir?: string;

  /** Custom storage directory for sessions. Default: ~/.code-shell/sessions */
  sessionStorageDir?: string;

  /** MCP servers to connect. */
  mcpServers?: EngineConfig["mcpServers"];

  /** Enabled builtin tools (add to preset defaults). */
  enabledBuiltinTools?: string[];

  /** Disabled builtin tools (remove from preset defaults). */
  disabledBuiltinTools?: string[];

  /** Custom system prompt (replaces preset prompt). */
  customSystemPrompt?: string;

  /** Append to system prompt (added after preset prompt). */
  appendSystemPrompt?: string;

  /** Optional evaluator for run completion. */
  evaluator?: Evaluator;
}

/**
 * Create a fully configured RunManager with one call.
 */
export function createRunManager(options: CreateRunManagerOptions): RunManager {
  const runsDir = options.runsDir ?? join(homedir(), ".code-shell", "runs");

  const store = new FileRunStore(runsDir);

  return new RunManager({
    store,
    executor: {
      llm: options.llm,
      maxTurns: options.maxTurns ?? 30,
      maxContextTokens: options.maxContextTokens ?? 200_000,
      permissionMode: options.permissionMode ?? "acceptEdits",
      sessionStorageDir: options.sessionStorageDir,
      mcpServers: options.mcpServers,
      enabledBuiltinTools: options.enabledBuiltinTools,
      disabledBuiltinTools: options.disabledBuiltinTools,
      customSystemPrompt: options.customSystemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
    },
    concurrency: options.concurrency ?? 1,
    runsDir,
    evaluator: options.evaluator,
  });
}
