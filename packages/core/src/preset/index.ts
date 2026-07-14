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
import {
  deriveBuiltinPresetExposure,
  deriveToolGatedPromptSections,
  type BuiltinTool,
} from "../tool-system/builtin/index.js";
import type { CapabilityModule } from "../capabilities/index.js";

export const AGENT_PRESET_NAMES = ["harness-min", "general"] as const;
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
  builtinTools: string[];
  defaultPermissionRules: PermissionRule[];
}

const HARNESS_MIN_EXPOSURE = deriveBuiltinPresetExposure("harness-min");
const GENERAL_EXPOSURE = deriveBuiltinPresetExposure("general");

// ─── Preset definitions ──────────────────────────────────────────

export const BUILTIN_AGENT_PRESETS: Record<BuiltinPresetName, AgentPreset> = {
  "harness-min": {
    name: "harness-min",
    label: "Minimal Agent Harness",
    description: "Domain-neutral orchestration with the minimal reusable tool surface.",
    promptSections: ["harness-base", "orchestration", "tone"],
    builtinTools: HARNESS_MIN_EXPOSURE.builtinTools,
    defaultPermissionRules: HARNESS_MIN_EXPOSURE.defaultPermissionRules,
  },
  general: {
    name: "general",
    label: "General Orchestrator",
    description:
      "Domain-agnostic orchestration for research, operations, automation, and long-running tasks.",
    promptSections: ["base", "orchestration", "browser", "tone"],
    builtinTools: GENERAL_EXPOSURE.builtinTools,
    defaultPermissionRules: GENERAL_EXPOSURE.defaultPermissionRules,
  },
};

export const DEFAULT_AGENT_PRESET: AgentPresetName = "harness-min";
/** @deprecated Product hosts should install a capability with `defaultPreset`. */
export const DEFAULT_CLI_PRESET: AgentPresetName = DEFAULT_AGENT_PRESET;

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
 *   builtinTools: ["Read", "Write", "Bash", "Glob", "Grep", "Agent"],
 *   defaultPermissionRules: [{ tool: "Read", decision: "allow" }],
 * });
 * ```
 */
export function registerPreset(preset: AgentPreset): void {
  _customPresets.set(preset.name, preset);
}

/** List all available preset names (built-in + custom). */
export function listPresetNames(capabilities: readonly CapabilityModule[] = []): string[] {
  return [
    ...new Set([
      ...AGENT_PRESET_NAMES,
      ..._customPresets.keys(),
      ...capabilities.flatMap((capability) =>
        (capability.presets ?? []).map((preset) => preset.name),
      ),
    ]),
  ];
}

export function resolveAgentPreset(
  name?: string,
  capabilities: readonly CapabilityModule[] = [],
): AgentPreset {
  let resolvedName = name;
  if (!resolvedName) {
    const defaults = [
      ...new Set(
        capabilities
          .map((capability) => capability.defaultPreset)
          .filter((preset): preset is string => Boolean(preset)),
      ),
    ];
    if (defaults.length > 1) {
      throw new Error(
        `Capabilities contributed conflicting default presets: ${defaults.join(", ")}`,
      );
    }
    resolvedName = defaults[0] ?? DEFAULT_AGENT_PRESET;
  }

  const contributed = capabilities
    .flatMap((capability) => [...(capability.presets ?? [])])
    .find((preset) => preset.name === resolvedName);
  if (contributed) return contributed;

  // Check built-in first
  const builtin = BUILTIN_AGENT_PRESETS[resolvedName as BuiltinPresetName];
  if (builtin) return builtin;

  // Check custom presets
  const custom = _customPresets.get(resolvedName);
  if (custom) return custom;

  const allowed = listPresetNames(capabilities).join(", ");
  throw new Error(`Unknown agent preset "${resolvedName}". Available presets: ${allowed}`);
}

/** Prompt-section capability links are contributed by builtin exposure metadata. */
const TOOL_GATED_SECTIONS = deriveToolGatedPromptSections();

export interface BuildPresetSystemPromptOptions {
  activeToolNames?: readonly string[];
  platform?: NodeJS.Platform;
  promptSections?: Readonly<Record<string, string>>;
  toolCatalog?: readonly BuiltinTool[];
}

function isActiveToolNamesList(
  value: BuildPresetSystemPromptOptions | readonly string[] | undefined,
): value is readonly string[] {
  return Array.isArray(value);
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
  const options: BuildPresetSystemPromptOptions = isActiveToolNamesList(optionsOrActiveToolNames)
    ? { activeToolNames: optionsOrActiveToolNames }
    : (optionsOrActiveToolNames ?? {});
  const activeToolNames = options.activeToolNames;
  if (activeToolNames) {
    const active = new Set(activeToolNames);
    sections = sections.filter((s) => {
      const gate = options.toolCatalog
        ? deriveToolGatedPromptSections(options.toolCatalog)[s]
        : TOOL_GATED_SECTIONS[s];
      return !gate || gate.some((t) => active.has(t));
    });
  }
  return [
    loadSections(sections, options.promptSections),
    platformShellGuidance(options.platform ?? process.platform),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function resolveBuiltinToolNames(options?: {
  preset?: string;
  host?: string;
  enabledBuiltinTools?: string[];
  disabledBuiltinTools?: string[];
  capabilities?: readonly CapabilityModule[];
}): string[] {
  const preset = resolveAgentPreset(options?.preset, options?.capabilities);
  const names = new Set(preset.builtinTools);

  for (const name of options?.enabledBuiltinTools ?? []) {
    names.add(name);
  }

  for (const capability of options?.capabilities ?? []) {
    capability.adjustToolSelection?.(names, {
      preset: preset.name,
      host: options?.host,
    });
  }

  for (const name of options?.disabledBuiltinTools ?? []) {
    names.delete(name);
  }

  return [...names];
}
