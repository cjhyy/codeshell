import { mergePluginMcpServers, SettingsManager } from "@cjhyy/code-shell-core";
import { computeEffectiveDisabledLists } from "@cjhyy/code-shell-core/internal";
import type { McpServerConfig } from "./mcp-probe-service.js";
import { readSettings } from "./settings-service.js";
import { rendererConfigurationCwd } from "./renderer-configuration-helpers.js";
import type { RendererConfigurationTarget } from "../shared/renderer-configuration.js";

export async function listMergedMcpServers(
  rawBase: unknown,
  rawDisabledPlugins?: unknown,
  target?: RendererConfigurationTarget | null,
) {
  const base =
    rawBase && typeof rawBase === "object" ? (rawBase as Record<string, McpServerConfig>) : {};
  const rawList = Array.isArray(rawDisabledPlugins)
    ? rawDisabledPlugins.filter((x): x is string => typeof x === "string")
    : [];
  // Fold project capabilityOverrides over the renderer's raw global list when
  // a cwd is known — the pluginDisabled flag must reflect the EFFECTIVE state
  // (能力总览 project "on" overrides global off), matching the engine's merge.
  const cwd = target == null ? undefined : await rendererConfigurationCwd(target);
  const disabledPlugins = cwd
    ? computeEffectiveDisabledLists(new SettingsManager(cwd, "full"), cwd).disabledPlugins
    : rawList;
  // Merge with ALL plugins (no disabled filter): an installed plugin's MCP
  // should be VISIBLE in the settings page even while the plugin is disabled
  // (feedback: 装了就该展示,而不是打开插件才出现). The engine's own connect
  // path still filters disabledPlugins, so a disabled plugin's server is
  // listed-but-inert; we mark it `pluginDisabled` for the UI.
  const disabledSet = new Set(disabledPlugins);
  // Plugin-MCP overrides live globally (user scope), independent of the active
  // settings scope — read them here and let the merge layer them onto plugin
  // servers so the listed env/credential reflects the EFFECTIVE connect config.
  const userSettings = ((await readSettings("user").catch(() => null)) ?? {}) as {
    mcpServerOverrides?: Record<string, McpServerConfig>;
  };
  const overrides = (userSettings.mcpServerOverrides ?? {}) as Record<string, McpServerConfig>;
  const merged = mergePluginMcpServers(base, [], overrides);
  return Object.fromEntries(
    Object.entries(merged).map(([name, cfg]) => {
      const fromSettings = Object.prototype.hasOwnProperty.call(base, name);
      const colon = name.indexOf(":");
      const owner = !fromSettings && colon > 0 ? name.slice(0, colon) : undefined;
      return [
        name,
        {
          ...cfg,
          name,
          source: fromSettings ? ("settings" as const) : ("plugin" as const),
          editable: fromSettings,
          pluginDisabled: owner !== undefined && disabledSet.has(owner),
          // Flag a plugin server that currently carries a user override so the
          // UI can badge it. (User-added servers never use the override layer.)
          hasOverride: !fromSettings && Object.prototype.hasOwnProperty.call(overrides, name),
        },
      ];
    }),
  );
}
