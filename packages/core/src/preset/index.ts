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
  "ApplyPatch",
  "Glob",
  "Grep",
  "Bash",
  // Bash(run_in_background=true) companions — without these in the preset
  // whitelist, the registry skips them (registerBuiltins filters BUILTIN_TOOLS
  // by the selected set), so a model that correctly calls BashOutput after
  // launching a background shell hits "Tool not found" and the turn dies.
  "BashOutput",
  "KillShell",
  "ListShells",
  // Browser automation (drive the in-app webview). Same whitelist requirement as
  // the BashOutput trio above: registerBuiltins filters BUILTIN_TOOLS by the
  // preset set, so without these the model calling browser_snapshot/etc. hits
  // "Tool not found". They self-degrade to a clear error when no browser panel
  // is wired (headless), so listing them unconditionally is safe.
  "browser_snapshot",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_read_content",
  // Extract real link/image URLs the a11y snapshot omits (href/src). Same
  // whitelist requirement as the other browser_* tools — without it the model
  // calling browser_extract_links hits "Tool not found".
  "browser_extract_links",
  "browser_wait",
  "browser_press_enter",
  "WebSearch",
  "WebFetch",
  "GenerateImage",
  "GenerateVideo",
  "AskUserQuestion",
  "Agent",
  // AgentStatus removed: background agents now write to ~/.code-shell/agents/
  // <id>.txt — the parent agent can Read/Bash tail that file for live progress.
  // The implementation is still in the registry for SDK consumers if needed.
  "AgentCancel",
  "EnterPlanMode",
  "ExitPlanMode",
  "ToolSearch",
  "TodoWrite",
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
  // Persistent cross-session memory. Including these in the default preset is
  // what lets the LLM list/read/save/delete memories during a normal session,
  // AND what makes the end-of-session auto-dream consolidation work — its
  // tool-call loop pulls these from the registry, so without them every dream
  // run bailed with "missing memory tools". Save/Delete in the user scope stay
  // permission-gated (the tools declare permissionDefault: "ask"); dream-scope
  // writes go through freely.
  "MemoryList",
  "MemoryRead",
  "MemorySave",
  "MemoryDelete",
  // AI 取用已存凭证(cookie/token/link)给 yt-dlp/curl 等。必须在 preset 白名单里
  // 否则 registerBuiltins 滤掉它 → 即使存了凭证、注册了工具,AI 列表里也没有
  // UseCredential(用户实测「找不到这个工具」的真因)。它带 isUseCredentialAvailable
  // guard:cwd 凭证库为空时仍自动隐藏,所以无条件列入是安全的(空库不会冒出来)。
  "UseCredential",
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
  { tool: "TodoWrite", decision: "allow" },
  { tool: "Sleep", decision: "allow" },
  { tool: "CronList", decision: "allow" },
  { tool: "Skill", decision: "allow" },
  { tool: "ListMcpResources", decision: "allow" },
  { tool: "ReadMcpResource", decision: "allow" },
  // Reading memory is always safe; writes (MemorySave/MemoryDelete) stay gated
  // by the tools' own permissionDefault so the user confirms each change.
  { tool: "MemoryList", decision: "allow" },
  { tool: "MemoryRead", decision: "allow" },
  // Browser automation: observing / navigating / reading are safe to auto-allow;
  // click & type act on the page so stay gated by their "ask" permissionDefault
  // (+ the main-side sensitive-action / domain-whitelist enforcement).
  { tool: "browser_snapshot", decision: "allow" },
  { tool: "browser_navigate", decision: "allow" },
  { tool: "browser_scroll", decision: "allow" },
  { tool: "browser_read_content", decision: "allow" },
  { tool: "browser_wait", decision: "allow" },
  { tool: "browser_press_enter", decision: "allow" },
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
