/**
 * Capability-control forwarders for the 扩展能力 settings page.
 *
 * The desktop main process imports core directly (same rationale as
 * skills-service): the agent worker isn't running between turns, and this is
 * "what's configured on disk" data. We build a fresh CapabilityService per
 * call — it holds no mutable state, so there's nothing to cache.
 *
 * Scope "full" is used so list() reflects the user-level toggles that
 * setEnabled writes (SettingsManager.saveUserSetting always targets
 * ~/.code-shell/settings.json; "project" scope wouldn't read that layer back).
 *
 * Note: the registry built here is NOT MCP-connected, so MCP toolCount reads
 * as 0. That's acceptable for the settings UI — a server's enabled/disabled
 * state is driven entirely by the mcpServers config, not by live tool counts.
 */

import {
  CapabilityService,
  BUILTIN_TOOLS,
  SettingsManager,
  ToolRegistry,
  scanSkills,
  readInstalledPlugins,
  resolveBuiltinToolNames,
  loadAgentDefinitionsForCwd,
  type CapabilityDescriptor,
} from "@cjhyy/code-shell-core";
import { CODING_CAPABILITY, CODING_TOOLS } from "@cjhyy/code-shell-capability-coding";

function makeService(cwd: string): CapabilityService {
  const settings = new SettingsManager(cwd, "full");
  const preset = (settings.get() as { agent?: { preset?: string } }).agent?.preset;
  const capabilities = [CODING_CAPABILITY];
  const registry = new ToolRegistry({
    builtinTools: resolveBuiltinToolNames({ preset, host: "desktop", capabilities }),
    toolCatalog: [...BUILTIN_TOOLS, ...CODING_TOOLS],
  });
  return new CapabilityService({
    registry,
    settings,
    cwd,
    scanSkills,
    // Full agent role set (user + project), UNFILTERED by disabledAgents so the
    // capability list shows disabled roles too. loadAgentDefinitionsForCwd
    // tolerates an empty cwd (skips the project dir → user roles only).
    scanAgents: (c: string) => loadAgentDefinitionsForCwd(c, [], []).list(),
    readInstalledPlugins,
    resolveBuiltinToolNames: (options) => resolveBuiltinToolNames({ ...options, capabilities }),
    builtinToolHost: "desktop",
  });
}

export function listCapabilities(cwd: string): CapabilityDescriptor[] {
  try {
    // A non-empty cwd → project view (descriptors carry the tri-state overlay
    // via globalEnabled/projectOverride/effectiveSource). Empty cwd → user view.
    return makeService(cwd).list(cwd || undefined);
  } catch {
    return [];
  }
}

export function setCapabilityEnabled(
  cwd: string,
  id: string,
  on: boolean,
  opts?: { scope?: "user" | "project" },
): void {
  makeService(cwd).setEnabled(id, on, { scope: opts?.scope ?? "user", cwd });
}

export function setCapabilityOverride(
  cwd: string,
  id: string,
  state: "inherit" | "on" | "off",
): void {
  makeService(cwd).setOverride(id, state, { scope: "project", cwd });
}
