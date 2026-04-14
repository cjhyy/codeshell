/**
 * defineProduct — assemble a domain-specific agent product from preset + adapter + contract.
 *
 * This is the primary entry point for external repos. One call produces a
 * ready-to-use RunManager that embodies the product's behavior.
 *
 * Example (in an external repo):
 * ```ts
 * import { defineProduct } from "code-shell";
 *
 * const { manager, preset } = defineProduct({
 *   preset: {
 *     name: "security-audit",
 *     label: "Security Audit Agent",
 *     description: "Scans repos for OWASP top 10 vulnerabilities.",
 *     sections: ["base", "orchestration"],
 *     appendPrompt: "You are a security expert. Focus on...",
 *   },
 *   adapter: {
 *     tools: [myCustomScanTool],
 *     enableTools: ["Read", "Glob", "Grep", "Bash"],
 *     permissionRules: [{ tool: "Bash", decision: "ask" }],
 *   },
 *   contract: {
 *     evaluator: new SecurityEvaluator(),
 *     defaultTags: ["security"],
 *     maxTurns: 50,
 *   },
 * }, {
 *   llm: { provider: "openai", model: "...", apiKey: "..." },
 * });
 *
 * await manager.submit({ objective: "Audit auth module for SQL injection" });
 * ```
 */

import type { LLMConfig, PermissionMode } from "../types.js";
import type { AgentPreset } from "../preset/index.js";
import { registerPreset } from "../preset/index.js";
import { CompositeEvaluator, NoopEvaluator, type Evaluator } from "../run/Evaluator.js";
import { RunManager } from "../run/RunManager.js";
import { FileRunStore } from "../run/FileRunStore.js";
import type { ProductDefinition, CustomTool } from "./types.js";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Runtime options (not part of the product definition) ────────

export interface ProductRuntimeOptions {
  /** LLM configuration (required). */
  llm: LLMConfig;
  /** Permission mode. Default: "acceptEdits" */
  permissionMode?: PermissionMode;
  /** Working directory. Default: process.cwd() */
  cwd?: string;
  /** Storage directory for runs. Default: ~/.code-shell/runs */
  runsDir?: string;
  /** Storage directory for sessions. */
  sessionStorageDir?: string;
}

// ─── Result ──────────────────────────────────────────────────────

export interface ProductInstance {
  /** The configured RunManager, ready for submit/resume/cancel. */
  manager: RunManager;
  /** The registered preset (can be used to create Engine directly). */
  preset: AgentPreset;
  /** Custom tools registered by the adapter (for reference). */
  customTools: CustomTool[];
}

// ─── Main function ─────────────────────────────────────��─────────

export function defineProduct(
  definition: ProductDefinition,
  runtime: ProductRuntimeOptions,
): ProductInstance {
  const { preset: presetDef, adapter, contract } = definition;

  // ── 1. Build and register preset ──────────────────────────────

  const presetName = presetDef.name;

  // Determine builtin tools: start from a base set, apply adapter overrides
  const baseTools = [
    "Read", "Write", "Edit", "Glob", "Grep", "Bash",
    "AskUserQuestion", "Agent", "ToolSearch",
    "TaskCreate", "TaskList", "TaskUpdate", "TaskGet",
  ];
  const enabledSet = new Set([...baseTools, ...(adapter?.enableTools ?? [])]);
  for (const t of adapter?.disableTools ?? []) {
    enabledSet.delete(t);
  }

  // Combine permission rules
  const permissionRules = [
    // Default safe rules
    { tool: "Read", decision: "allow" as const },
    { tool: "Glob", decision: "allow" as const },
    { tool: "Grep", decision: "allow" as const },
    { tool: "AskUserQuestion", decision: "allow" as const },
    { tool: "ToolSearch", decision: "allow" as const },
    { tool: "TaskCreate", decision: "allow" as const },
    { tool: "TaskList", decision: "allow" as const },
    { tool: "TaskUpdate", decision: "allow" as const },
    { tool: "TaskGet", decision: "allow" as const },
    // Product-specific rules (higher priority)
    ...(adapter?.permissionRules ?? []),
  ];

  const agentPreset: AgentPreset = {
    name: presetName as AgentPreset["name"],
    label: presetDef.label,
    description: presetDef.description,
    promptSections: presetDef.sections ?? ["base", "orchestration"],
    injectGitStatus: presetDef.injectGitStatus ?? false,
    builtinTools: [...enabledSet],
    defaultPermissionRules: permissionRules,
  };

  registerPreset(agentPreset);

  // ── 2. Build evaluator from contract ──────────────────────────

  let evaluator: Evaluator;
  if (!contract?.evaluator) {
    evaluator = new NoopEvaluator();
  } else if (Array.isArray(contract.evaluator)) {
    evaluator = new CompositeEvaluator(contract.evaluator);
  } else {
    evaluator = contract.evaluator;
  }

  // ── 3. Collect custom tools ────────────────────────────────────

  const customTools = adapter?.tools ?? [];

  // Convert product CustomTool[] to EngineRunner's CustomToolEntry[]
  const customToolEntries = customTools.map((ct) => ({
    definition: ct.definition,
    execute: ct.execute,
  }));

  // ── 4. Build RunManager ───────────────────────────────────────

  const runsDir = runtime.runsDir ?? join(homedir(), ".code-shell", "runs");
  const store = new FileRunStore(runsDir);

  const manager = new RunManager({
    store,
    executor: {
      llm: runtime.llm,
      maxTurns: contract?.maxTurns ?? 30,
      maxContextTokens: contract?.maxContextTokens ?? 200_000,
      permissionMode: runtime.permissionMode ?? "acceptEdits",
      sessionStorageDir: runtime.sessionStorageDir,
      mcpServers: adapter?.mcpServers,
      enabledBuiltinTools: [...enabledSet],
      disabledBuiltinTools: adapter?.disableTools,
      customSystemPrompt: presetDef.customPrompt,
      appendSystemPrompt: presetDef.appendPrompt,
      customTools: customToolEntries.length > 0 ? customToolEntries : undefined,
    },
    concurrency: contract?.concurrency ?? 1,
    runsDir,
    evaluator,
  });

  return { manager, preset: agentPreset, customTools };
}
