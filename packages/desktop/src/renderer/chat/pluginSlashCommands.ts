import type { PluginCommandDescriptor } from "../../shared/plugin-commands";

export type SlashCommandItem =
  | {
      kind: "builtin";
      name: "/compact" | "/loop";
      title: string;
      description: string;
      argumentHint?: string;
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
  return command.argumentHint ? `${command.name} ` : command.name;
}

export function parseLoopSlashInvocation(
  draft: string,
  commands: readonly SlashCommandItem[],
): { rawArguments: string } | null {
  const command = commands.find((item) => item.kind === "builtin" && item.name === "/loop");
  if (!command) return null;
  const input = draft.trim();
  if (!input.startsWith(command.name)) return null;
  const boundary = input.charAt(command.name.length);
  if (boundary && !/\s/u.test(boundary)) return null;
  return { rawArguments: input.slice(command.name.length).trim() };
}

export function buildLoopCommandPrompt(rawArguments: string): string {
  const command = rawArguments.trim() ? `/loop ${rawArguments.trim()}` : "/loop";
  return [
    "Handle the following CodeShell standalone /loop command.",
    "Use the project skill named loop-mode and follow its command semantics and durable .loop state contract.",
    "This is not Goal mode: do not create, update, resume, pause, delete, or depend on a CodeShell Goal.",
    `Original command: ${command}`,
  ].join("\n");
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
