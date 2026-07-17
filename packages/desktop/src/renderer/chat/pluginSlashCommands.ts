import type { PluginCommandDescriptor } from "../../shared/plugin-commands";

export type SlashCommandItem =
  | {
      kind: "builtin";
      name: "/compact";
      title: string;
      description: string;
    }
  | {
      kind: "plugin";
      name: string;
      title: string;
      description: string;
      argumentHint?: string;
      pluginName: string;
      pluginCommandName: string;
    };

export function toPluginSlashCommandItems(
  commands: readonly PluginCommandDescriptor[],
  fallbackDescription: (pluginName: string) => string,
): SlashCommandItem[] {
  return commands.map((command) => ({
    kind: "plugin" as const,
    name: `/${command.name}`,
    title: command.pluginName,
    description: command.description || fallbackDescription(command.pluginName),
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    pluginName: command.pluginName,
    pluginCommandName: command.name,
  }));
}

export function filterSlashCommandItems(
  commands: readonly SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...commands];
  return commands.filter((command) =>
    [
      command.name.slice(1),
      command.title,
      command.description,
      command.kind === "plugin" ? command.argumentHint : undefined,
    ].some((value) => value?.toLowerCase().includes(normalized)),
  );
}

export function completedSlashCommandDraft(command: SlashCommandItem): string {
  return command.kind === "plugin" && command.argumentHint ? `${command.name} ` : command.name;
}

export function parsePluginSlashInvocation(
  draft: string,
  commands: readonly SlashCommandItem[],
): { command: Extract<SlashCommandItem, { kind: "plugin" }>; rawArguments: string } | null {
  const input = draft.trim();
  for (const command of commands) {
    if (command.kind !== "plugin" || !input.startsWith(command.name)) continue;
    const boundary = input.charAt(command.name.length);
    if (boundary && !/\s/u.test(boundary)) continue;
    return {
      command,
      rawArguments: input.slice(command.name.length).trim(),
    };
  }
  return null;
}
