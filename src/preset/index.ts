/**
 * Built-in agent presets.
 *
 * Presets keep the core engine domain-agnostic while letting callers choose
 * a default prompt, default tools, and safe permission shortcuts.
 *
 * System prompts are assembled from reusable markdown sections in
 * src/prompt/sections/*.md — each preset declares which sections to include.
 */

import type { PermissionRule } from "../types.js";
import { loadSections } from "../prompt/section-loader.js";

export const AGENT_PRESET_NAMES = ["general", "terminal-coding"] as const;
/** Built-in preset names. Custom presets use arbitrary strings via registerPreset(). */
export type BuiltinPresetName = (typeof AGENT_PRESET_NAMES)[number];
/** Any preset name — built-in or custom-registered. */
export type AgentPresetName = BuiltinPresetName | (string & {});

export interface AgentPreset {
  name: AgentPresetName;
  label: string;
  description: string;
  /** Ordered list of prompt section filenames (without .md). */
  promptSections: readonly string[];
  /** Whether to inject git status into system context. */
  injectGitStatus: boolean;
  builtinTools: string[];
  defaultPermissionRules: PermissionRule[];
}

// ─── Tool sets ───────────────────────────────────────────────────

const GENERAL_BUILTIN_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebSearch",
  "WebFetch",
  "AskUserQuestion",
  "Agent",
  "AgentStatus",
  "AgentCancel",
  "EnterPlanMode",
  "ExitPlanMode",
  "ToolSearch",
  "TaskCreate",
  "TaskList",
  "TaskUpdate",
  "TaskStop",
  "TaskGet",
  "TaskOutput",
  "SendMessage",
  "Sleep",
  "Config",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Skill",
  "MCPTool",
  "ListMcpResources",
  "ReadMcpResource",
  "RemoteTrigger",
  "REPL",
  "PowerShell",
] as const;

const TERMINAL_CODING_EXTRA_TOOLS = [
  "EnterWorktree",
  "ExitWorktree",
  "NotebookEdit",
  "LSP",
  "Brief",
  "Arena",
] as const;

// ─── Permission rules ────────────────────────────────────────────

const GENERAL_PERMISSION_RULES: PermissionRule[] = [
  { tool: "Read", decision: "allow" },
  { tool: "Glob", decision: "allow" },
  { tool: "Grep", decision: "allow" },
  { tool: "WebSearch", decision: "allow" },
  { tool: "WebFetch", decision: "allow" },
  { tool: "AskUserQuestion", decision: "allow" },
  { tool: "Agent", decision: "allow" },
  { tool: "AgentStatus", decision: "allow" },
  { tool: "AgentCancel", decision: "allow" },
  { tool: "EnterPlanMode", decision: "allow" },
  { tool: "ExitPlanMode", decision: "allow" },
  { tool: "ToolSearch", decision: "allow" },
  { tool: "TaskCreate", decision: "allow" },
  { tool: "TaskList", decision: "allow" },
  { tool: "TaskUpdate", decision: "allow" },
  { tool: "TaskStop", decision: "allow" },
  { tool: "TaskGet", decision: "allow" },
  { tool: "TaskOutput", decision: "allow" },
  { tool: "Sleep", decision: "allow" },
  { tool: "CronList", decision: "allow" },
  { tool: "Skill", decision: "allow" },
  { tool: "ListMcpResources", decision: "allow" },
  { tool: "ReadMcpResource", decision: "allow" },
];

// ─── Preset definitions ──────────────────────────────────────────

export const BUILTIN_AGENT_PRESETS: Record<AgentPresetName, AgentPreset> = {
  general: {
    name: "general",
    label: "General Orchestrator",
    description: "Domain-agnostic orchestration for research, operations, automation, and long-running tasks.",
    promptSections: ["base", "orchestration", "tone"],
    injectGitStatus: false,
    builtinTools: [...GENERAL_BUILTIN_TOOLS],
    defaultPermissionRules: GENERAL_PERMISSION_RULES,
  },
  "terminal-coding": {
    name: "terminal-coding",
    label: "Terminal Coding Assistant",
    description: "General orchestration plus coding-focused guidance and code-navigation tools.",
    promptSections: ["base", "orchestration", "coding", "tone"],
    injectGitStatus: true,
    builtinTools: [...GENERAL_BUILTIN_TOOLS, ...TERMINAL_CODING_EXTRA_TOOLS],
    defaultPermissionRules: [
      ...GENERAL_PERMISSION_RULES,
      { tool: "LSP", decision: "allow" },
      { tool: "Brief", decision: "allow" },
    ],
  },
};

export const DEFAULT_AGENT_PRESET: AgentPresetName = "general";
export const DEFAULT_CLI_PRESET: AgentPresetName = "terminal-coding";

/** Registry of custom presets registered by external consumers. */
const _customPresets = new Map<string, AgentPreset>();

/**
 * Register a custom agent preset.
 *
 * External repos can call this to add their own presets:
 * ```ts
 * import { registerPreset } from "code-shell";
 *
 * registerPreset({
 *   name: "data-pipeline" as AgentPresetName,
 *   label: "Data Pipeline Orchestrator",
 *   description: "Manages ETL workflows and data quality checks.",
 *   promptSections: ["base", "orchestration"],
 *   injectGitStatus: false,
 *   builtinTools: ["Read", "Write", "Bash", "Glob", "Grep", "Agent"],
 *   defaultPermissionRules: [{ tool: "Read", decision: "allow" }],
 * });
 * ```
 */
export function registerPreset(preset: AgentPreset): void {
  _customPresets.set(preset.name, preset);
}

/** List all available preset names (built-in + custom). */
export function listPresetNames(): string[] {
  return [...AGENT_PRESET_NAMES, ..._customPresets.keys()];
}

export function resolveAgentPreset(name?: string): AgentPreset {
  if (!name) return BUILTIN_AGENT_PRESETS[DEFAULT_AGENT_PRESET];

  // Check built-in first
  const builtin = BUILTIN_AGENT_PRESETS[name as AgentPresetName];
  if (builtin) return builtin;

  // Check custom presets
  const custom = _customPresets.get(name);
  if (custom) return custom;

  const allowed = listPresetNames().join(", ");
  throw new Error(`Unknown agent preset "${name}". Available presets: ${allowed}`);
}

/**
 * Build the full system prompt for a preset by loading and joining its sections.
 */
export function buildPresetSystemPrompt(preset: AgentPreset): string {
  return loadSections(preset.promptSections);
}

export function resolveBuiltinToolNames(options?: {
  preset?: string;
  enabledBuiltinTools?: string[];
  disabledBuiltinTools?: string[];
}): string[] {
  const preset = resolveAgentPreset(options?.preset);
  const names = new Set(preset.builtinTools);

  for (const name of options?.enabledBuiltinTools ?? []) {
    names.add(name);
  }

  for (const name of options?.disabledBuiltinTools ?? []) {
    names.delete(name);
  }

  return [...names];
}
