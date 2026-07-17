import {
  SettingsManager,
  expandPluginCommandBody,
  scanPluginCommands,
  type PluginCommand,
} from "@cjhyy/code-shell-core";
import { computeEffectiveDisabledLists } from "@cjhyy/code-shell-core/internal";
import type { ExpandedPluginCommand, PluginCommandDescriptor } from "../shared/plugin-commands.js";

type PluginCommandSource = Pick<
  PluginCommand,
  "name" | "pluginName" | "description" | "argumentHint" | "body"
>;

function effectiveDisabledPluginNames(cwd: string): Set<string> {
  try {
    const settingsCwd = cwd || process.cwd();
    return new Set(
      computeEffectiveDisabledLists(new SettingsManager(settingsCwd, "full"), cwd || undefined)
        .disabledPlugins,
    );
  } catch {
    return new Set();
  }
}

/** Pure DTO projection used by the IPC service and unit tests. */
export function describeEnabledPluginCommands(
  commands: readonly PluginCommandSource[],
  disabledPluginNames: ReadonlySet<string>,
): PluginCommandDescriptor[] {
  return commands
    .filter((command) => !disabledPluginNames.has(command.pluginName))
    .map((command) => ({
      name: command.name,
      pluginName: command.pluginName,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Pure trusted expansion helper; command bodies never cross into the renderer. */
export function expandEnabledPluginCommand(
  commands: readonly PluginCommandSource[],
  disabledPluginNames: ReadonlySet<string>,
  name: string,
  rawArguments: string,
): ExpandedPluginCommand {
  const command = commands.find(
    (candidate) => candidate.name === name && !disabledPluginNames.has(candidate.pluginName),
  );
  if (!command) throw new Error(`plugin command is unavailable: ${name}`);
  return { prompt: expandPluginCommandBody(command.body, rawArguments) };
}

export function listPluginCommands(cwd: string): PluginCommandDescriptor[] {
  try {
    return describeEnabledPluginCommands(scanPluginCommands(), effectiveDisabledPluginNames(cwd));
  } catch {
    return [];
  }
}

export function expandPluginCommand(
  cwd: string,
  name: string,
  rawArguments: string,
): ExpandedPluginCommand {
  return expandEnabledPluginCommand(
    scanPluginCommands(),
    effectiveDisabledPluginNames(cwd),
    name,
    rawArguments,
  );
}
