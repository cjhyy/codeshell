/**
 * Convert PluginCommand[] (from pluginCommandsLoader) to SlashCommand[]
 * registrable on the CommandRegistry. Each command's execute() reads
 * the body, substitutes $ARGUMENTS / {args}, and stages the result via
 * ctx.setNextContext so the user can submit by pressing Enter.
 */

import type { SlashCommand } from "../registry.js";
import { scanPluginCommands, type PluginCommand } from "../../../plugins/pluginCommandsLoader.js";

function pluginCommandToSlash(pc: PluginCommand): SlashCommand {
  const usage = pc.argumentHint ? `/${pc.name} ${pc.argumentHint}` : `/${pc.name}`;
  return {
    name: `/${pc.name}`,
    description: pc.description || `Plugin command from ${pc.pluginName}`,
    usage,
    group: "advanced",
    execute: (arg, ctx) => {
      const expanded = pc.body
        .replace(/\$ARGUMENTS/g, arg ?? "")
        .replace(/\{args\}/g, arg ?? "");
      ctx.setNextContext(expanded);
      ctx.addStatus(
        `Prompt staged from ${pc.name}. Press Enter to submit (or edit your message first).`,
      );
    },
  };
}

/**
 * Returns the full list of SlashCommands derived from currently-installed
 * plugins. Caller registers them on the CommandRegistry.
 */
export function buildPluginSlashCommands(): SlashCommand[] {
  return scanPluginCommands().map(pluginCommandToSlash);
}
