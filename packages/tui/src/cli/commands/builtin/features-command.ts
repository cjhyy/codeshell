/**
 * /features command — list the current feature-flag state.
 *
 * Read-only: flags are toggled in settings.json (settings.featureFlags) or the
 * Customize UI; this surfaces the resolved state (defaults merged with the
 * settings overlay) so users can see what's on without opening settings.
 */

import type { SlashCommand } from "../registry.js";

export const featuresCommand: SlashCommand = {
  name: "/features",
  group: "config",
  description: "List feature flags and their current state",
  usage: "/features",
  execute: async (_arg, ctx) => {
    const configResult = await ctx.client.query("config");
    const config = configResult.data as { featureFlags?: Record<string, boolean> };
    const flags = config.featureFlags ?? {};
    const names = Object.keys(flags).sort();

    if (names.length === 0) {
      ctx.addStatus("No feature flags reported by the engine.");
      return;
    }

    const lines = [
      "Feature flags (set in settings.json → featureFlags):",
      "",
      ...names.map((name) => `  ${flags[name] ? "on " : "off"}  ${name}`),
      "",
      'Toggle via settings.json, e.g. {"featureFlags": {"undo": true}}.',
    ];
    ctx.addStatus(lines.join("\n"));
  },
};
