import { describe, expect, test } from "bun:test";
import {
  describeEnabledPluginCommands,
  expandEnabledPluginCommand,
} from "./plugin-command-service";

const commands = [
  {
    name: "demo:review",
    pluginName: "demo",
    description: "Review a change",
    argumentHint: "<path> [FOCUS=value]",
    body: "Review $1 with focus $FOCUS. Raw: $ARGUMENTS",
  },
  {
    name: "hidden:plan",
    pluginName: "hidden",
    description: "Hidden command",
    body: "Plan $ARGUMENTS",
  },
];

describe("desktop plugin command service", () => {
  test("projects only renderer-safe metadata and respects disabled plugins", () => {
    const result = describeEnabledPluginCommands(commands, new Set(["hidden"]));

    expect(result).toEqual([
      {
        name: "demo:review",
        pluginName: "demo",
        description: "Review a change",
        argumentHint: "<path> [FOCUS=value]",
      },
    ]);
    expect(result[0]).not.toHaveProperty("body");
    expect(result[0]).not.toHaveProperty("filePath");
  });

  test("expands the trusted body with positional and named arguments", () => {
    expect(
      expandEnabledPluginCommand(commands, new Set(), "demo:review", '"src/app.ts" FOCUS=security'),
    ).toEqual({
      prompt: 'Review src/app.ts with focus security. Raw: "src/app.ts" FOCUS=security',
    });
  });

  test("does not expand commands from disabled plugins", () => {
    expect(() =>
      expandEnabledPluginCommand(commands, new Set(["demo"]), "demo:review", ""),
    ).toThrow("plugin command is unavailable");
  });
});
