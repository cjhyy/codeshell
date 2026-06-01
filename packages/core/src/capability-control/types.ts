/**
 * Capability-control descriptor types.
 *
 * A read-only projection layer over the four extension-capability loaders
 * (builtin tools, MCP servers, skills, plugins). A CapabilityDescriptor is a
 * computed view, never a source of truth — the truth stays in the loaders +
 * settings. Each descriptor carries an inlined `control` describing how to
 * toggle it, so the switch router never has to branch on `kind`.
 *
 * See docs/superpowers/specs/2026-05-29-capability-control-design.md
 */

/** A uniform, read-only projection of one extension capability. */
export interface CapabilityDescriptor {
  /** Globally unique; the source prefix isolates the namespace. */
  id: string;
  kind: "builtin" | "mcp" | "skill" | "plugin";
  /** Display name: builtin=tool, mcp=server, skill=skill, plugin=plugin. */
  name: string;
  /** One-line description pulled from the underlying metadata. */
  description: string;
  /** Computed from preset defaults + the relevant switch config. */
  enabled: boolean;
  /** Which settings key the switch writes, and how. */
  control: CapabilityControl;
  /** user/global baseline enablement, before any project overlay. */
  globalEnabled?: boolean;
  /** Project overlay state in a project-scope view. Absent === inherit. */
  projectOverride?: "on" | "off";
  /** Where the effective `enabled` value came from. */
  effectiveSource?: "user" | "project" | "default";
  /** Source details for UI grouping / navigation. */
  origin?: {
    serverName?: string;
    pluginName?: string;
    filePath?: string;
    toolCount?: number;
    isReadOnly?: boolean;
  };
}

/** Describes which settings key the switch writes and the write semantics. */
export interface CapabilityControl {
  settingsKey:
    | "agent.enabledBuiltinTools"
    | "agent.disabledBuiltinTools"
    | "mcpServers"
    | "disabledSkills"
    | "disabledPlugins";
  /**
   *  - "denylist"    → off = token present in array (disabled*); on = removed
   *  - "allowlist"   → on  = token present in array (enabled*); off = removed
   *  - "record-flag" → flip mcpServers[token].enabled
   */
  mode: "denylist" | "allowlist" | "record-flag";
  /** Identifier written into the array, or used as the record key. */
  token: string;
}

export class CapabilityNotFoundError extends Error {
  constructor(id: string) {
    super(`Capability not found: ${id}`);
    this.name = "CapabilityNotFoundError";
  }
}

/**
 * Which settings file a capability write targets. Distinct from
 * SettingsManager's disk-READ scope ("isolated" | "project" | "full"): this is
 * the WRITE scope — user → global settings, project → capabilityOverrides.
 */
export type WriteScope = "user" | "project";

/** Tri-state project override as seen by callers. */
export type CapabilityOverrideState = "inherit" | "on" | "off";
