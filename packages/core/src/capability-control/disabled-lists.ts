/**
 * Effective disabled-skills/plugins computation — the ONE place that folds a
 * project's capabilityOverrides (tri-state on/off/inherit) over the global
 * baseline, plus the no-repo whitelist inversion.
 *
 * Extracted from Engine.readDisabledLists because the MCP merge consumers
 * (engineFactory in the stdio/tcp servers, diskDefaultsFrom hot-reload) were
 * passing the RAW global `settings.disabledPlugins` to mergePluginMcpServers:
 * a plugin force-enabled at project level (能力总览 "on") stayed excluded from
 * the MCP merge because the global list still named it. Every consumer must
 * fold through here so "project on overrides global off" holds everywhere.
 */

import { SettingsManager, noRepoDir } from "../settings/manager.js";
import { scanSkills } from "../skills/scanner.js";
import { readInstalledPlugins } from "../plugins/installedPlugins.js";
import {
  effectiveDisabledList,
  effectiveProjectOverrides,
  whitelistDisabledList,
} from "./overlay.js";

export interface EffectiveDisabledLists {
  disabledSkills: string[];
  disabledPlugins: string[];
  /** Folded from capabilityOverrides.pluginHooks "off" keys (see
   *  pluginHookKey) — per-hook suppression for plugin-provided hooks. */
  disabledPluginHooks: string[];
}

/**
 * Compute the effective disabled lists for `cwd`. Never throws — any read
 * error falls back to empty lists (same contract as Engine.readDisabledLists).
 */
export function computeEffectiveDisabledLists(
  sm: SettingsManager,
  cwd: string | undefined,
): EffectiveDisabledLists {
  try {
    const settings = sm.get() as {
      disabledSkills?: string[];
      disabledPlugins?: string[];
    };
    // Read the project overlay UNMERGED (getForScope), not the merged get(),
    // so tri-state inheritance survives. No cwd / no overlay → the baseline
    // is returned unchanged (zero regression).
    const overrides = effectiveProjectOverrides(sm, cwd);
    // no-repo "conversation" scope: INVERT skill/plugin filtering to a
    // whitelist (default-all-off, only explicit "on" survives). Only this
    // fixed cwd flips; every real project keeps the denylist below. agent/
    // mcp/builtin are NOT inverted. See conversation-settings spec §3.
    if (cwd && cwd === noRepoDir()) {
      const allSkillNames = scanSkills(cwd).map((s) => s.name);
      const allPluginNames = Object.keys(readInstalledPlugins().plugins).map((key) => {
        const at = key.lastIndexOf("@");
        return at > 0 ? key.slice(0, at) : key;
      });
      return {
        disabledSkills: whitelistDisabledList(allSkillNames, overrides?.skills),
        disabledPlugins: whitelistDisabledList(allPluginNames, overrides?.plugins),
        // pluginHooks is NOT inverted (like agents/mcp/builtin): there is no
        // global per-hook baseline, only project-level "off" keys.
        disabledPluginHooks: effectiveDisabledList([], overrides?.pluginHooks),
      };
    }
    return {
      disabledSkills: effectiveDisabledList(settings.disabledSkills ?? [], overrides?.skills),
      disabledPlugins: effectiveDisabledList(settings.disabledPlugins ?? [], overrides?.plugins),
      disabledPluginHooks: effectiveDisabledList([], overrides?.pluginHooks),
    };
  } catch {
    return { disabledSkills: [], disabledPlugins: [], disabledPluginHooks: [] };
  }
}
