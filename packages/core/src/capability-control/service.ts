/**
 * CapabilityService — the single control-layer entry point.
 *
 *  - list(): composes the four projections into one CapabilityDescriptor[].
 *  - setEnabled(id, on): reads the target descriptor's inlined `control` and
 *    routes the write to the right settings key. It never branches on `kind`.
 *
 * Dependencies are injected (not imported) so the service is unit-testable
 * without touching disk: the engine / desktop wiring supplies the real
 * ToolRegistry, SettingsManager, and loaders.
 *
 * See docs/superpowers/specs/2026-05-29-capability-control-design.md
 */

import type { ToolRegistry } from "../tool-system/registry.js";
import type { SettingsManager } from "../settings/manager.js";
import type { SkillDefinition } from "../skills/scanner.js";
import type { InstalledPluginsV2 } from "../plugins/types.js";
import type { CapabilityDescriptor } from "./types.js";
import { CapabilityNotFoundError } from "./types.js";
import {
  projectBuiltin,
  projectMcp,
  projectSkills,
  projectPlugins,
} from "./project.js";

export interface CapabilityServiceDeps {
  registry: Pick<ToolRegistry, "listToolsDetailed">;
  settings: Pick<SettingsManager, "get" | "saveUserSetting">;
  cwd: string;
  scanSkills: (
    cwd: string,
    opts?: { disabledSkills?: string[]; disabledPlugins?: string[] },
  ) => SkillDefinition[];
  readInstalledPlugins: () => InstalledPluginsV2;
  resolveBuiltinToolNames: (o?: {
    preset?: string;
    enabledBuiltinTools?: string[];
    disabledBuiltinTools?: string[];
  }) => string[];
}

export class CapabilityService {
  constructor(private readonly deps: CapabilityServiceDeps) {}

  list(): CapabilityDescriptor[] {
    const s = this.deps.settings.get() as Record<string, any>;
    const agent = (s.agent ?? {}) as Record<string, any>;
    const tools = this.deps.registry.listToolsDetailed();
    const preset: string | undefined = agent.preset;

    return [
      ...projectBuiltin({
        tools: tools.filter((t) => t.source === "builtin"),
        presetDefaults: this.deps.resolveBuiltinToolNames({ preset }),
        effective: this.deps.resolveBuiltinToolNames({
          preset,
          enabledBuiltinTools: agent.enabledBuiltinTools ?? [],
          disabledBuiltinTools: agent.disabledBuiltinTools ?? [],
        }),
      }),
      ...projectMcp({
        mcpServers: s.mcpServers ?? {},
        mcpTools: tools.filter((t) => t.source === "mcp"),
      }),
      ...projectSkills({
        skills: this.deps.scanSkills(this.deps.cwd, {}),
        disabledSkills: s.disabledSkills ?? [],
      }),
      ...projectPlugins({
        installed: this.deps.readInstalledPlugins().plugins,
        disabledPlugins: s.disabledPlugins ?? [],
      }),
    ];
  }

  setEnabled(id: string, on: boolean): void {
    const descriptor = this.list().find((c) => c.id === id);
    if (!descriptor) throw new CapabilityNotFoundError(id);
    const { settingsKey, mode, token } = descriptor.control;
    const s = this.deps.settings.get() as Record<string, any>;

    if (mode === "record-flag") {
      const servers = { ...(s.mcpServers ?? {}) };
      // Never conjure a server that was never configured.
      if (!servers[token]) return;
      servers[token] = { ...servers[token], enabled: on };
      this.deps.settings.saveUserSetting("mcpServers", servers);
      return;
    }

    const arr = new Set<string>(readArray(s, settingsKey));
    // denylist: present ⇒ OFF, so we want it present when turning off.
    const wantPresent = mode === "allowlist" ? on : !on;
    if (wantPresent) arr.add(token);
    else arr.delete(token);
    this.deps.settings.saveUserSetting(settingsKey, [...arr]);
  }
}

/** Read an array at a dotted settings path (e.g. agent.disabledBuiltinTools). */
function readArray(s: Record<string, any>, key: string): string[] {
  let cur: any = s;
  for (const part of key.split(".")) cur = cur?.[part];
  return Array.isArray(cur) ? cur : [];
}
