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
  // Browser automation (drive the in-app webview) — 3 semantic tools. Same
  // whitelist requirement as the BashOutput trio above: registerBuiltins filters
  // BUILTIN_TOOLS by the preset set, so without these the model calling
  // browser_observe/etc. hits "Tool not found". They self-degrade to a clear
  // error when no browser panel is wired (headless), so listing is safe.
  "browser_observe",
  "browser_act",
  "browser_navigate",
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
  // cc-orchestrator:驱动外部 claude CLI 跑一轮。同 BashOutput/UseCredential/
  // EditModelCatalog 的 whitelist 要求:已在 BUILTIN_TOOLS 注册,但 registerBuiltins
  // 按 preset 集过滤 → 名单里没有它,agent 就没有「指挥 Claude Code」的工具,只能幻觉
  // RemoteTrigger / 兜底 Bash `claude -p`(用户实测「为什么驱动 cc 没作为工具」)。
  // 定时/循环驱动统一走 CronCreate(到点跑一轮引擎,prompt 里调 DriveAgent);
  // 无人值守审批由 DriveAgent 自身 bypass 解决,不需要定时层专门的 CC 调度工具。
  // DriveAgent 是通用驱动(cli: claude|codex);DriveClaudeCode 保留为 cli:claude 的
  // 别名(老 prompt/记忆兼容)。两个都要在白名单里,否则 registerBuiltins 滤掉。
  "DriveAgent",
  "DriveClaudeCode",
  // 编排时读 CC/Codex 剩余额度做规划(开几个/等重置/换 provider)。
  "CheckQuota",
  "Skill",
  "MCPTool",
  "ListMcpResources",
  "ReadMcpResource",
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
  // 同理:把 cookie 凭证注入内置浏览器(恢复登录态后用 browser_* 工具)。带
  // isInjectCredentialAvailable guard(无 cookie 凭证时自动隐藏),无条件列入安全。
  "InjectCredential",
  // AI 增/改模型 catalog(写 ~/.code-shell/model-catalog.user.json)。同 BashOutput/
  // UseCredential 一样的 whitelist 要求:registerBuiltins 按 preset 集过滤 BUILTIN_TOOLS,
  // 名单里没有它 → 即使工具已注册,AI 列表里也没有 → 用户实测「找不到这个工具」。
  // permissionDefault: "ask",列入只是让 AI 看得到,调用仍走审批,无条件列入安全。
  "EditModelCatalog",
  // Goal-mode control tools. Same whitelist requirement as the rest:
  // registerBuiltins filters BUILTIN_TOOLS by the preset set, so a goal tool
  // absent here is registered-but-invisible — the model never sees it and can
  // neither self-declare completion (complete_goal) nor honor a user's request
  // to abandon the goal (cancel_goal), stranding a persistent goal that only a
  // manual disk edit could clear. cancel_goal is the "strong intent" escape
  // hatch (requires confirm+reason); the turn-loop enforces the guard.
  "complete_goal",
  "cancel_goal",
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
  { tool: "CheckQuota", decision: "allow" },
  { tool: "Skill", decision: "allow" },
  // ListMcpResources only enumerates resource names (and the executor filters
  // the list to this session's enabled servers). ReadMcpResource pulls actual
  // content and is intentionally NOT auto-allowed here — it falls back to its
  // tool-level "ask" default so a default-mode session confirms the read.
  { tool: "ListMcpResources", decision: "allow" },
  // Reading memory is always safe; writes (MemorySave/MemoryDelete) stay gated
  // by the tools' own permissionDefault so the user confirms each change.
  { tool: "MemoryList", decision: "allow" },
  { tool: "MemoryRead", decision: "allow" },
  // Browser automation (3 semantic tools). Rules are first-match-wins, ordered
  // by specificity — so the action-gating rule for browser_act MUST come first:
  // click/type/select mutate the page/form → "ask"; all other actions (hover/
  // scroll/wait/press_key/list_tabs/switch_tab) fall through to browser_act's
  // tool-level "allow". observe (read-only) and navigate auto-allow.
  // (Main-side sensitive-action + domain-whitelist enforcement also applies.)
  {
    tool: "browser_act",
    argsPattern: { action: "^(click|type|select)$" },
    decision: "ask",
    reason: "browser_act click/type/select mutate the page",
  },
  { tool: "browser_observe", decision: "allow" },
  { tool: "browser_navigate", decision: "allow" },
];

// ─── Preset definitions ──────────────────────────────────────────

export const BUILTIN_AGENT_PRESETS: Record<AgentPresetName, AgentPreset> = {
  general: {
    name: "general",
    label: "General Orchestrator",
    description: "Domain-agnostic orchestration for research, operations, automation, and long-running tasks.",
    promptSections: ["base", "orchestration", "browser", "tone"],
    injectGitStatus: false,
    builtinTools: [...GENERAL_BUILTIN_TOOLS],
    defaultPermissionRules: GENERAL_PERMISSION_RULES,
  },
  "terminal-coding": {
    name: "terminal-coding",
    label: "Terminal Coding Assistant",
    description: "General orchestration plus coding-focused guidance and code-navigation tools.",
    promptSections: ["base", "orchestration", "coding", "browser", "tone"],
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

/** Tool names that gate the "browser" prompt section — if NONE of these are in
 *  the active tool set (browser capability turned off), the section is dropped
 *  so the model isn't told how to use tools it can't see. Keep in sync with the
 *  browser tools registered in builtin/index.ts. */
const BROWSER_SECTION_TOOLS = ["browser_observe", "browser_act", "browser_navigate"];

/** Prompt sections whose inclusion is gated by an active tool being present. */
const TOOL_GATED_SECTIONS: Record<string, string[]> = {
  browser: BROWSER_SECTION_TOOLS,
};

export interface BuildPresetSystemPromptOptions {
  activeToolNames?: readonly string[];
  platform?: NodeJS.Platform;
}

function platformShellGuidance(platform: NodeJS.Platform): string {
  if (platform !== "win32") return "";
  return [
    "# Windows Shell Guidance",
    "- On Windows, Bash uses Git Bash when it is available. Prefer Bash for ordinary shell commands, git operations, package-manager commands, tests, and POSIX-style command lines.",
    "- Do not choose PowerShell merely because the OS is Windows. Use PowerShell only when the user explicitly asks for it or the task requires PowerShell-specific cmdlets, Windows APIs, registry access, or `.ps1` behavior.",
    "- When writing Bash commands on Windows, use Git Bash paths such as `/d/github/project` instead of PowerShell-only syntax or raw `D:\\...` paths inside `cd` commands.",
  ].join("\n");
}

/**
 * Build the full system prompt for a preset by loading and joining its sections.
 *
 * `activeToolNames` (the turn's effective tool set, post capability-override
 * filtering) gates tool-coupled sections: the "browser" section is dropped when
 * no browser tool is active, so the browser capability is a single on/off unit
 * (tools + usage instructions disappear together). Omit `activeToolNames` to
 * include all sections (e.g. when assembling a generic/preview prompt).
 */
export function buildPresetSystemPrompt(
  preset: AgentPreset,
  optionsOrActiveToolNames?: BuildPresetSystemPromptOptions | readonly string[],
): string {
  let sections = preset.promptSections;
  const options = Array.isArray(optionsOrActiveToolNames)
    ? { activeToolNames: optionsOrActiveToolNames }
    : (optionsOrActiveToolNames ?? {});
  const activeToolNames = options.activeToolNames;
  if (activeToolNames) {
    const active = new Set(activeToolNames);
    sections = sections.filter((s) => {
      const gate = TOOL_GATED_SECTIONS[s];
      return !gate || gate.some((t) => active.has(t));
    });
  }
  return [loadSections(sections), platformShellGuidance(options.platform ?? process.platform)]
    .filter(Boolean)
    .join("\n\n");
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
