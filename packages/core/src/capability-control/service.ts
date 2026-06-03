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
import type { AgentDefinition } from "../agent/agent-definition.js";
import type { InstalledPluginsV2 } from "../plugins/types.js";
import type { CapabilityDescriptor, WriteScope, CapabilityOverrideState } from "./types.js";
import { CapabilityNotFoundError } from "./types.js";
import {
  projectBuiltin,
  projectMcp,
  projectSkills,
  projectPlugins,
  projectAgents,
} from "./project.js";
import {
  applyOverride,
  bucketForKind,
  overrideTokenForId,
  overrideFor,
} from "./overlay.js";
import type { CapabilityOverrides } from "../settings/schema.js";

export interface CapabilityServiceDeps {
  registry: Pick<ToolRegistry, "listToolsDetailed">;
  settings: Pick<
    SettingsManager,
    "get" | "saveUserSetting" | "saveProjectSetting" | "deleteProjectSetting" | "getForScope"
  >;
  cwd: string;
  scanSkills: (
    cwd: string,
    opts?: { disabledSkills?: string[]; disabledPlugins?: string[] },
  ) => SkillDefinition[];
  /** Full agent role set for `cwd` (user + project), loaded WITHOUT the
   *  disabled filter so disabled roles still list and can be re-enabled. */
  scanAgents: (cwd: string) => AgentDefinition[];
  readInstalledPlugins: () => InstalledPluginsV2;
  resolveBuiltinToolNames: (o?: {
    preset?: string;
    enabledBuiltinTools?: string[];
    disabledBuiltinTools?: string[];
  }) => string[];
}

export class CapabilityService {
  constructor(private readonly deps: CapabilityServiceDeps) {}

  /**
   * List capability descriptors. With no `cwd` this is the user/global view
   * (enabled === global baseline). With a `cwd` it's that project's view:
   * each descriptor gains globalEnabled / projectOverride / effectiveSource
   * and `enabled` reflects the tri-state overlay (spec §6.1).
   */
  list(cwd?: string): CapabilityDescriptor[] {
    const s = this.deps.settings.get() as Record<string, any>;
    const agent = (s.agent ?? {}) as Record<string, any>;
    const tools = this.deps.registry.listToolsDetailed();
    const preset: string | undefined = agent.preset;

    const base: CapabilityDescriptor[] = [
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
      ...projectAgents({
        agents: this.deps.scanAgents(this.deps.cwd),
        disabledAgents: s.disabledAgents ?? [],
      }),
    ];

    const overrides: CapabilityOverrides | undefined = cwd
      ? (this.deps.settings.getForScope("project", cwd).capabilityOverrides as CapabilityOverrides)
      : undefined;

    return base.map((d) => {
      const globalEnabled = d.enabled;
      const token = overrideTokenForId(d.id);
      const ov = cwd ? overrideFor(overrides, d.kind, token) : undefined;
      const enabled = applyOverride(globalEnabled, ov);
      return {
        ...d,
        enabled,
        globalEnabled,
        projectOverride: ov,
        effectiveSource: ov ? "project" : cwd ? "default" : "user",
      } as CapabilityDescriptor;
    });
  }

  /**
   * Toggle a capability. Default scope is "user" (back-compat: old callers
   * pass no opts → global write, unchanged). scope:"project" maps on/off to a
   * tri-state override and writes capabilityOverrides (requires cwd).
   */
  setEnabled(id: string, on: boolean, opts?: { scope?: WriteScope; cwd?: string }): void {
    if (opts?.scope === "project") {
      this.setOverride(id, on ? "on" : "off", {
        scope: "project",
        cwd: opts.cwd ?? this.deps.cwd,
      });
      return;
    }
    this.writeUserScope(id, on);
  }

  /**
   * Write a project tri-state override. "inherit" deletes the key (we never
   * persist the literal). All capability kinds — including builtin, which
   * writes to capabilityOverrides.builtin.<token> — now support project
   * overrides; only a kind with no bucket (bucketForKind returns undefined)
   * is rejected.
   */
  setOverride(
    id: string,
    state: CapabilityOverrideState,
    opts: { scope: "project"; cwd: string },
  ): void {
    const descriptor = this.list().find((c) => c.id === id);
    if (!descriptor) throw new CapabilityNotFoundError(id);
    const bucket = bucketForKind(descriptor.kind);
    if (!bucket) throw new Error(`Capability kind '${descriptor.kind}' has no project override`);
    if (!opts.cwd) throw new Error("project override requires cwd");
    const token = overrideTokenForId(id);
    const path = `capabilityOverrides.${bucket}.${token}`;
    if (state === "inherit") this.deps.settings.deleteProjectSetting(path, opts.cwd);
    else this.deps.settings.saveProjectSetting(path, state, opts.cwd);
  }

  /** Existing global write path — unchanged behavior, refactored out of setEnabled. */
  private writeUserScope(id: string, on: boolean): void {
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
