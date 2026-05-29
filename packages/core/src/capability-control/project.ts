/**
 * Pure projection functions: each turns one loader's output + the relevant
 * slice of current settings into CapabilityDescriptor[]. No I/O, no state —
 * the CapabilityService feeds them and composes the results.
 *
 * See docs/superpowers/specs/2026-05-29-capability-control-design.md
 */

import type { RegisteredTool, MCPServerConfig } from "../types.js";
import type { SkillDefinition } from "../skills/scanner.js";
import type { CapabilityDescriptor } from "./types.js";

/**
 * Builtin tools. A tool's switch lives in the denylist when it ships in the
 * preset default set (turning it off = adding to agent.disabledBuiltinTools),
 * and in the allowlist otherwise (turning it on = adding to
 * agent.enabledBuiltinTools). This mirrors resolveBuiltinToolNames, whose
 * effective set is `preset.builtinTools ∪ enabled − disabled`.
 */
export function projectBuiltin(input: {
  tools: RegisteredTool[];
  presetDefaults: string[];
  effective: string[];
}): CapabilityDescriptor[] {
  const defaults = new Set(input.presetDefaults);
  const on = new Set(input.effective);
  return input.tools.map((t) => {
    const inPreset = defaults.has(t.name);
    return {
      id: `builtin:${t.name}`,
      kind: "builtin" as const,
      name: t.name,
      description: t.description,
      enabled: on.has(t.name),
      control: inPreset
        ? {
            settingsKey: "agent.disabledBuiltinTools" as const,
            mode: "denylist" as const,
            token: t.name,
          }
        : {
            settingsKey: "agent.enabledBuiltinTools" as const,
            mode: "allowlist" as const,
            token: t.name,
          },
      origin: { isReadOnly: t.isReadOnly },
    };
  });
}

/**
 * MCP, projected per server (not per tool). Every configured server gets a
 * descriptor — including unconnected ones — driven by the mcpServers config;
 * tool counts come from the registry's connected mcp tools (0 if none).
 */
export function projectMcp(input: {
  mcpServers: Record<string, MCPServerConfig>;
  mcpTools: RegisteredTool[];
}): CapabilityDescriptor[] {
  const counts = new Map<string, number>();
  for (const t of input.mcpTools) {
    if (t.source !== "mcp" || !t.serverName) continue;
    counts.set(t.serverName, (counts.get(t.serverName) ?? 0) + 1);
  }
  return Object.entries(input.mcpServers).map(([serverName, cfg]) => {
    const toolCount = counts.get(serverName) ?? 0;
    return {
      id: `mcp:${serverName}`,
      kind: "mcp" as const,
      name: serverName,
      description: `${toolCount} tools`,
      enabled: cfg.enabled !== false,
      control: {
        settingsKey: "mcpServers" as const,
        mode: "record-flag" as const,
        token: serverName,
      },
      origin: { serverName, toolCount },
    };
  });
}

/**
 * Project/user skills. The caller MUST pass the FULL skill set (scanSkills
 * with empty opts), because scanSkills filters disabled entries out — passing
 * a filtered set would drop disabled skills from the list, leaving the UI no
 * way to re-enable them. Plugin-sourced skills are excluded here; they surface
 * under their plugin via projectPlugins.
 */
export function projectSkills(input: {
  skills: SkillDefinition[];
  disabledSkills: string[];
}): CapabilityDescriptor[] {
  const disabled = new Set(input.disabledSkills);
  return input.skills
    .filter((s) => s.source === "project" || s.source === "user")
    .map((s) => ({
      id: `skill:${s.name}`,
      kind: "skill" as const,
      name: s.name,
      description: s.description,
      enabled: !disabled.has(s.name),
      control: {
        settingsKey: "disabledSkills" as const,
        mode: "denylist" as const,
        token: s.name,
      },
      origin: { filePath: s.filePath },
    }));
}

/**
 * Installed plugins, projected per plugin. Install keys are `<plugin>@<market>`;
 * the bare plugin name is the substring before the last `@` and matches the
 * `plugin:` prefix that disabledPlugins controls.
 */
export function projectPlugins(input: {
  installed: Record<string, unknown>;
  disabledPlugins: string[];
}): CapabilityDescriptor[] {
  const disabled = new Set(input.disabledPlugins);
  const names = new Set<string>();
  for (const key of Object.keys(input.installed)) {
    const at = key.lastIndexOf("@");
    names.add(at > 0 ? key.slice(0, at) : key);
  }
  return [...names].map((name) => ({
    id: `plugin:${name}`,
    kind: "plugin" as const,
    name,
    description: "",
    enabled: !disabled.has(name),
    control: {
      settingsKey: "disabledPlugins" as const,
      mode: "denylist" as const,
      token: name,
    },
    origin: { pluginName: name },
  }));
}
