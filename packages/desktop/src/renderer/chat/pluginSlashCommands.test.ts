import { describe, expect, test } from "bun:test";
import {
  completedSlashCommandDraft,
  filterSlashCommandItems,
  parsePluginSlashInvocation,
  toPluginSlashCommandItems,
  type SlashCommandItem,
} from "./pluginSlashCommands";

const items = toPluginSlashCommandItems(
  [
    {
      name: "demo:review",
      pluginName: "demo",
      description: "Review a code change",
      argumentHint: "<path> [FOCUS=value]",
    },
    {
      name: "writer:outline",
      pluginName: "writer",
      description: "",
    },
  ],
  (pluginName) => `Provided by ${pluginName}`,
);

describe("plugin slash command helpers", () => {
  test("searches names, descriptions, plugin names, and argument hints", () => {
    expect(filterSlashCommandItems(items, "review")).toHaveLength(1);
    expect(filterSlashCommandItems(items, "code change")).toHaveLength(1);
    expect(filterSlashCommandItems(items, "demo")).toHaveLength(1);
    expect(filterSlashCommandItems(items, "focus=value")).toHaveLength(1);
  });

  test("adds an argument-ready space only when a hint is present", () => {
    expect(completedSlashCommandDraft(items[0])).toBe("/demo:review ");
    expect(completedSlashCommandDraft(items[1])).toBe("/writer:outline");
  });

  test("parses exact plugin commands with raw arguments and rejects prefix collisions", () => {
    expect(parsePluginSlashInvocation('/demo:review "src/app.ts" FOCUS=security', items)).toEqual({
      command: items[0],
      rawArguments: '"src/app.ts" FOCUS=security',
    });
    expect(parsePluginSlashInvocation("/demo:review-extra", items)).toBeNull();
  });

  test("ignores builtin slash commands", () => {
    const builtin: SlashCommandItem = {
      kind: "builtin",
      name: "/compact",
      title: "Compact",
      description: "Compact context",
    };
    expect(parsePluginSlashInvocation("/compact", [builtin, ...items])).toBeNull();
  });
});
